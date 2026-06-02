#!/usr/bin/env node
import { spawnSync }                    from 'node:child_process';
import { existsSync, readFileSync }     from 'node:fs';
import { resolve, extname, join }       from 'node:path';
import { parse as acornParse }          from 'acorn';

// ── ANSI colors ───────────────────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  green:  '\x1b[32m',
  cyan:   '\x1b[36m',
  gray:   '\x1b[90m',
};
const col = (code, str) => `${code}${str}${C.reset}`;

// ── Help ──────────────────────────────────────────────────────────────────────
const HELP = `
${col(C.bold + C.cyan, 'code-churn')} — visualize git file churn to surface code smells

${col(C.bold, 'Usage:')}
  code-churn <repo-path> [options]

${col(C.bold, 'Options:')}
  --top <n>        Show top N files (or files to scan with --functions)  (default: 20)
  --since <date>   Only commits after date      (e.g. 2024-01-01)
  --until <date>   Only commits before date
  --ext <ext>      Filter by extension          (e.g. .js or js)
  --path <prefix>  Filter by path prefix        (e.g. src/)
  --merges         Include merge commits         (excluded by default)
  --functions      Show function-level churn for top JS/MJS/CJS files
  --json           Output raw JSON
  -h, --help       Show this help

${col(C.bold, 'Examples:')}
  code-churn ./my-repo
  code-churn ./my-repo --top 10 --since 2024-01-01 --ext .ts
  code-churn ./my-repo --path src/ --functions
  code-churn ./my-repo --functions --top 3 --json
`;

// ── Arg parsing ───────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {
    top: null, merges: false, json: false, functions: false,
    ext: null, path: null, since: null, until: null, repoPath: null,
  };
  const raw = argv.slice(2);

  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (a === '-h' || a === '--help')   { process.stdout.write(HELP); process.exit(0); }
    else if (a === '--json')            args.json = true;
    else if (a === '--merges')          args.merges = true;
    else if (a === '--functions')       args.functions = true;
    else if (a === '--top')             args.top = parseInt(raw[++i], 10) || 20;
    else if (a === '--since')           args.since = raw[++i];
    else if (a === '--until')           args.until = raw[++i];
    else if (a === '--ext')             args.ext = raw[++i]?.replace(/^\./, '');
    else if (a === '--path')            args.path = raw[++i];
    else if (!a.startsWith('--'))       args.repoPath = resolve(a);
  }

  // Sensible defaults depending on mode
  if (args.top === null) args.top = args.functions ? 5 : 20;

  return args;
}

// ── Git helpers ───────────────────────────────────────────────────────────────
function git(repoPath, gitArgs) {
  const result = spawnSync('git', ['-C', repoPath, ...gitArgs], {
    encoding: 'utf8',
    maxBuffer: 200 * 1024 * 1024,
  });
  if (result.error) throw new Error(`git not found: ${result.error.message}`);
  if (result.status !== 0) throw new Error(result.stderr?.trim() || 'git command failed');
  return result.stdout;
}

function getDateRange(repoPath) {
  try {
    const first = git(repoPath, ['log', '--reverse', '--pretty=format:%ad', '--date=short']).split('\n')[0];
    const last  = git(repoPath, ['log', '-1', '--pretty=format:%ad', '--date=short']).trim();
    return { first, last };
  } catch {
    return { first: '?', last: '?' };
  }
}

function countCommits(repoPath, extraArgs) {
  try {
    return parseInt(git(repoPath, ['rev-list', '--count', 'HEAD', ...extraArgs]).trim(), 10);
  } catch {
    return 0;
  }
}

// ── File churn analysis ───────────────────────────────────────────────────────
function analyzeFiles(repoPath, opts) {
  const gitArgs = ['log', '--name-only', '--pretty=format:'];
  if (!opts.merges) gitArgs.push('--no-merges');
  if (opts.since)   gitArgs.push(`--since=${opts.since}`);
  if (opts.until)   gitArgs.push(`--until=${opts.until}`);

  const raw    = git(repoPath, gitArgs);
  const counts = new Map();

  for (const line of raw.split('\n')) {
    const file = line.trim();
    if (!file) continue;
    if (opts.ext  && extname(file).replace(/^\./, '') !== opts.ext) continue;
    if (opts.path && !file.startsWith(opts.path))                   continue;
    counts.set(file, (counts.get(file) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, opts.top)
    .map(([file, changes]) => ({ file, changes }));
}

// ── AST: extract named function ranges from a JS file ────────────────────────
const PARSEABLE_EXTS  = new Set(['js', 'mjs', 'cjs']);
const HTTP_METHODS    = new Set(['get', 'post', 'put', 'patch', 'delete', 'use', 'all', 'options', 'head']);
const SKIP_AST_KEYS   = new Set(['type', 'loc', 'start', 'end']);

function extractFunctions(absPath) {
  let src;
  try { src = readFileSync(absPath, 'utf8'); } catch { return []; }

  let ast;
  for (const sourceType of ['module', 'script']) {
    try {
      ast = acornParse(src, { ecmaVersion: 'latest', sourceType, locations: true });
      break;
    } catch { /* try next sourceType */ }
  }
  if (!ast) return [];

  const fns = [];

  function walk(node, parent) {
    if (!node || typeof node !== 'object' || !node.type) return;

    let name = null;
    const isFn = node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression';

    if (node.type === 'FunctionDeclaration' && node.id) {
      // function foo() {}
      name = node.id.name;

    } else if (node.type === 'MethodDefinition') {
      // class Foo { bar() {} }
      const k = node.key;
      name = k.type === 'Identifier' ? k.name : String(k.value ?? '');
      if (node.kind === 'get' || node.kind === 'set') name = `${node.kind} ${name}`;
      if (node.static) name = `static ${name}`;

    } else if (isFn && parent?.type === 'VariableDeclarator' && parent.id?.type === 'Identifier') {
      // const foo = () => {}  /  const foo = function() {}
      name = parent.id.name;

    } else if (isFn && parent?.type === 'Property' && parent.key?.type === 'Identifier') {
      // { foo: () => {} }  /  { foo() {} } shorthand
      name = parent.key.name;

    } else if (
      isFn &&
      parent?.type === 'AssignmentExpression' &&
      parent.left?.type === 'MemberExpression' &&
      parent.left.property?.type === 'Identifier'
    ) {
      // this.foo = () => {}  /  module.exports.foo = function() {}
      name = parent.left.property.name;

    } else if (
      isFn &&
      parent?.type === 'CallExpression' &&
      parent.callee?.type === 'MemberExpression' &&
      HTTP_METHODS.has(parent.callee.property?.name) &&
      parent.arguments.at(-1) === node
    ) {
      // router.get('/path', middleware, async (req, res) => {})
      const method  = parent.callee.property.name.toUpperCase();
      const pathArg = parent.arguments.find(a => a.type === 'Literal' && typeof a.value === 'string');
      name = pathArg ? `${method} ${pathArg.value}` : method;
    }

    if (name && node.loc) {
      fns.push({ name, startLine: node.loc.start.line, endLine: node.loc.end.line });
    }

    for (const key of Object.keys(node)) {
      if (SKIP_AST_KEYS.has(key)) continue;
      const val = node[key];
      if (Array.isArray(val))                              val.forEach(c => walk(c, node));
      else if (val && typeof val === 'object' && val.type) walk(val, node);
    }
  }

  walk(ast, null);
  return fns;
}

// ── Function churn: one git log -p call per file, map hunks → functions ──────
const FUNCTIONS_TOP = 10;

function analyzeFunctionChurn(repoPath, filePath, fns, opts) {
  const gitArgs = ['log', '-p', '--unified=0', '--pretty=format:%H'];
  if (!opts.merges) gitArgs.push('--no-merges');
  if (opts.since)   gitArgs.push(`--since=${opts.since}`);
  if (opts.until)   gitArgs.push(`--until=${opts.until}`);
  gitArgs.push('--', filePath);

  const raw    = git(repoPath, gitArgs);
  const counts = new Map(fns.map(f => [f.name, 0]));

  // Parse @@ hunk headers: @@ -old +new_start[,new_count] @@
  // new_start/new_count describe lines added/changed in the new version
  for (const line of raw.split('\n')) {
    const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!m) continue;

    const hunkStart = parseInt(m[1], 10);
    const hunkCount = m[2] !== undefined ? parseInt(m[2], 10) : 1;
    if (hunkCount === 0) continue; // pure deletion — no new lines

    const hunkEnd = hunkStart + hunkCount - 1;

    for (const fn of fns) {
      if (fn.endLine < hunkStart || fn.startLine > hunkEnd) continue;
      counts.set(fn.name, counts.get(fn.name) + 1);
    }
  }

  return [...counts.entries()]
    .filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, FUNCTIONS_TOP)
    .map(([name, changes]) => ({ name, changes }));
}

// ── Rendering helpers ─────────────────────────────────────────────────────────
const BAR_WIDTH = 20;

function bar(value, max) {
  const filled = Math.round((value / max) * BAR_WIDTH);
  return '█'.repeat(filled) + col(C.dim, '░'.repeat(BAR_WIDTH - filled));
}

function tierColor(rank, total) {
  if (rank / total <= 0.2) return C.red;
  if (rank / total <= 0.5) return C.yellow;
  return C.green;
}

function printHeader(repoPath, totalCommits, opts) {
  const { first, last } = getDateRange(repoPath);
  const from = opts.since ?? first;
  const to   = opts.until ?? last;

  const filters = [
    opts.ext        && `ext=.${opts.ext}`,
    opts.path       && `path=${opts.path}`,
    opts.since      && `since=${opts.since}`,
    opts.until      && `until=${opts.until}`,
    opts.merges     && 'with merges',
    opts.functions  && 'function churn',
  ].filter(Boolean);

  console.log();
  console.log(col(C.bold, 'Code Churn Analysis') + col(C.gray, ` — ${repoPath}`));
  console.log(
    col(C.dim, `Commits analyzed: ${totalCommits.toLocaleString()}  |  Period: ${from} → ${to}`) +
    (filters.length ? col(C.dim, `  |  ${filters.join(', ')}`) : '')
  );
}

function printFileTable(results) {
  if (!results.length) {
    console.log(col(C.yellow, 'No files found matching the given filters.'));
    return;
  }

  const maxChanges = results[0].changes;
  const rankW      = String(results.length).length;
  const countW     = Math.max(7, String(maxChanges).length);

  console.log();
  console.log([
    col(C.bold, ' Rank'.padStart(rankW + 1)),
    col(C.bold, 'Changes'.padStart(countW)),
    col(C.bold, 'Bar'.padEnd(BAR_WIDTH + 2)),
    col(C.bold, 'File'),
  ].join('  '));
  console.log(col(C.dim, '─'.repeat(rankW + 2 + countW + 2 + BAR_WIDTH + 4 + 50)));

  results.forEach(({ file, changes }, i) => {
    const clr = tierColor(i + 1, results.length);
    console.log([
      col(clr,          String(i + 1).padStart(rankW + 1)),
      col(clr + C.bold, String(changes).padStart(countW)),
      col(clr,          bar(changes, maxChanges)),
      col(clr,          file),
    ].join('  '));
  });
}

function printFunctionSection(filePath, fileChanges, fnResults) {
  const ext = extname(filePath).replace(/^\./, '');
  console.log();
  console.log(col(C.bold, `  ${filePath}`) + col(C.dim, ` (${fileChanges} file commits)`));

  if (!PARSEABLE_EXTS.has(ext)) {
    console.log(col(C.dim, `  ↳ skipped — function parsing only supports .js/.mjs/.cjs`));
    return;
  }
  if (!fnResults.length) {
    console.log(col(C.dim, `  ↳ no named functions detected or file was deleted`));
    return;
  }

  const maxChanges = fnResults[0].changes;
  const rankW      = String(fnResults.length).length;
  const countW     = Math.max(7, String(maxChanges).length);
  const indent     = '  ';

  console.log(indent + [
    col(C.bold, ' Rank'.padStart(rankW + 1)),
    col(C.bold, 'Changes'.padStart(countW)),
    col(C.bold, 'Bar'.padEnd(BAR_WIDTH + 2)),
    col(C.bold, 'Function'),
  ].join('  '));
  console.log(indent + col(C.dim, '─'.repeat(rankW + 2 + countW + 2 + BAR_WIDTH + 4 + 40)));

  fnResults.forEach(({ name, changes }, i) => {
    const clr = tierColor(i + 1, fnResults.length);
    console.log(indent + [
      col(clr,          String(i + 1).padStart(rankW + 1)),
      col(clr + C.bold, String(changes).padStart(countW)),
      col(clr,          bar(changes, maxChanges)),
      col(clr,          name),
    ].join('  '));
  });
}

function printSmellHints(fileResults, fnResultsMap, totalCommits) {
  const hints = [];
  if (!fileResults.length) return;

  const top     = fileResults[0].changes;
  const top5sum = fileResults.slice(0, 5).reduce((s, r) => s + r.changes, 0);
  const top5pct = totalCommits ? Math.round((top5sum / totalCommits) * 100) : 0;

  if (top > 100)
    hints.push(`${col(C.red, '⚠')}  ${col(C.bold, fileResults[0].file)} has ${top} commits — likely a God Object or config hub.`);
  else if (top > 50)
    hints.push(`${col(C.yellow, '⚠')}  ${col(C.bold, fileResults[0].file)} has high churn (${top} commits) — may be doing too much.`);

  if (top5pct > 40)
    hints.push(`${col(C.yellow, '⚠')}  Top 5 files account for ${top5pct}% of all file changes — concentrated responsibility.`);

  const suspects = fileResults.filter(r => /container|index|config/.test(r.file.split('/').pop()));
  if (suspects.length >= 2)
    hints.push(`${col(C.cyan, 'ℹ')}  Multiple entry/config files in top results — consider splitting wiring from business logic.`);

  // Function-level hints
  for (const [file, fnResults] of Object.entries(fnResultsMap)) {
    if (!fnResults.length) continue;
    const topFn = fnResults[0];
    if (topFn.changes > 30)
      hints.push(`${col(C.red, '⚠')}  ${col(C.bold, topFn.name)}() in ${file} touched in ${topFn.changes} commits — consider breaking it up.`);
  }

  if (hints.length) {
    console.log();
    hints.forEach(h => console.log(h));
  }
  console.log();
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main() {
  const opts = parseArgs(process.argv);

  if (!opts.repoPath) {
    process.stderr.write(`${col(C.red, 'Error:')} no repository path provided.\n\nRun with --help for usage.\n`);
    process.exit(1);
  }
  if (!existsSync(opts.repoPath)) {
    process.stderr.write(`${col(C.red, 'Error:')} path does not exist: ${opts.repoPath}\n`);
    process.exit(1);
  }
  if (!existsSync(join(opts.repoPath, '.git'))) {
    process.stderr.write(`${col(C.red, 'Error:')} not a git repository: ${opts.repoPath}\n`);
    process.exit(1);
  }

  let fileResults, totalCommits;
  try {
    const countArgs = [];
    if (!opts.merges) countArgs.push('--no-merges');
    if (opts.since)   countArgs.push(`--since=${opts.since}`);
    if (opts.until)   countArgs.push(`--until=${opts.until}`);

    totalCommits = countCommits(opts.repoPath, countArgs);
    fileResults  = analyzeFiles(opts.repoPath, opts);
  } catch (err) {
    process.stderr.write(`${col(C.red, 'Error:')} ${err.message}\n`);
    process.exit(1);
  }

  // ── Function mode ───────────────────────────────────────────────────────────
  if (opts.functions) {
    const fnResultsMap = {};

    for (const { file, changes } of fileResults) {
      const ext = extname(file).replace(/^\./, '');
      if (!PARSEABLE_EXTS.has(ext)) { fnResultsMap[file] = []; continue; }

      const absPath = join(opts.repoPath, file);
      const fns     = existsSync(absPath) ? extractFunctions(absPath) : [];
      fnResultsMap[file] = fns.length
        ? analyzeFunctionChurn(opts.repoPath, file, fns, opts)
        : [];
    }

    if (opts.json) {
      console.log(JSON.stringify({
        totalCommits,
        files: fileResults.map(r => ({
          ...r,
          functions: fnResultsMap[r.file] ?? [],
        })),
      }, null, 2));
      return;
    }

    printHeader(opts.repoPath, totalCommits, opts);
    for (const { file, changes } of fileResults) {
      printFunctionSection(file, changes, fnResultsMap[file] ?? []);
    }
    printSmellHints(fileResults, fnResultsMap, totalCommits);
    return;
  }

  // ── File mode (default) ─────────────────────────────────────────────────────
  if (opts.json) {
    console.log(JSON.stringify({ totalCommits, files: fileResults }, null, 2));
    return;
  }

  printHeader(opts.repoPath, totalCommits, opts);
  printFileTable(fileResults);
  printSmellHints(fileResults, {}, totalCommits);
}

main();
