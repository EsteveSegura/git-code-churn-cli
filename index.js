#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, extname } from 'node:path';

// ── ANSI colors ──────────────────────────────────────────────────────────────
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

// ── Help ─────────────────────────────────────────────────────────────────────
const HELP = `
${col(C.bold + C.cyan, 'code-churn')} — visualize git file churn to surface code smells

${col(C.bold, 'Usage:')}
  code-churn <repo-path> [options]

${col(C.bold, 'Options:')}
  --top <n>        Show top N files            (default: 20)
  --since <date>   Only commits after date     (e.g. 2024-01-01)
  --until <date>   Only commits before date
  --ext <ext>      Filter by extension         (e.g. .js or js)
  --path <prefix>  Filter by path prefix       (e.g. src/)
  --merges         Include merge commits        (excluded by default)
  --json           Output raw JSON
  -h, --help       Show this help

${col(C.bold, 'Examples:')}
  code-churn ./my-repo
  code-churn ./my-repo --top 10 --since 2024-01-01 --ext .ts
  code-churn ./my-repo --path src/ --json
`;

// ── Arg parsing ───────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { top: 20, merges: false, json: false, ext: null, path: null, since: null, until: null, repoPath: null };
  const raw = argv.slice(2);

  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (a === '-h' || a === '--help') { process.stdout.write(HELP); process.exit(0); }
    else if (a === '--json')          args.json = true;
    else if (a === '--merges')        args.merges = true;
    else if (a === '--top')           args.top = parseInt(raw[++i], 10) || 20;
    else if (a === '--since')         args.since = raw[++i];
    else if (a === '--until')         args.until = raw[++i];
    else if (a === '--ext')           args.ext = raw[++i]?.replace(/^\./, '');
    else if (a === '--path')          args.path = raw[++i];
    else if (!a.startsWith('--'))     args.repoPath = resolve(a);
  }

  return args;
}

// ── Git helpers ───────────────────────────────────────────────────────────────
function git(repoPath, gitArgs) {
  const result = spawnSync('git', ['-C', repoPath, ...gitArgs], { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 });
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
    const out = git(repoPath, ['rev-list', '--count', 'HEAD', ...extraArgs]);
    return parseInt(out.trim(), 10);
  } catch {
    return 0;
  }
}

// ── Core analysis ─────────────────────────────────────────────────────────────
function analyze(repoPath, opts) {
  const gitArgs = ['log', '--name-only', '--pretty=format:'];
  if (!opts.merges) gitArgs.push('--no-merges');
  if (opts.since)   gitArgs.push(`--since=${opts.since}`);
  if (opts.until)   gitArgs.push(`--until=${opts.until}`);

  const raw = git(repoPath, gitArgs);
  const counts = new Map();

  for (const line of raw.split('\n')) {
    const file = line.trim();
    if (!file) continue;

    if (opts.ext && extname(file).replace(/^\./, '') !== opts.ext) continue;
    if (opts.path && !file.startsWith(opts.path)) continue;

    counts.set(file, (counts.get(file) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, opts.top)
    .map(([file, changes]) => ({ file, changes }));
}

// ── Rendering ─────────────────────────────────────────────────────────────────
const BAR_WIDTH = 20;

function bar(value, max) {
  const filled = Math.round((value / max) * BAR_WIDTH);
  const empty  = BAR_WIDTH - filled;
  return '█'.repeat(filled) + col(C.dim, '░'.repeat(empty));
}

function fileColor(rank, total) {
  if (rank / total <= 0.2) return C.red;
  if (rank / total <= 0.5) return C.yellow;
  return C.green;
}

function smellHints(results, totalCommits) {
  const hints = [];
  if (!results.length) return hints;

  const top = results[0].changes;
  const top5sum = results.slice(0, 5).reduce((s, r) => s + r.changes, 0);
  const top5pct = totalCommits ? Math.round((top5sum / totalCommits) * 100) : 0;

  if (top > 100) hints.push(`${col(C.red, '⚠')}  ${col(C.bold, results[0].file)} has ${top} commits — likely a God Object or config hub.`);
  else if (top > 50) hints.push(`${col(C.yellow, '⚠')}  ${col(C.bold, results[0].file)} has high churn (${top} commits) — may be doing too much.`);

  if (top5pct > 40) hints.push(`${col(C.yellow, '⚠')}  Top 5 files account for ${top5pct}% of all file changes — concentrated responsibility.`);

  const suspects = results.filter(r => /container|index|config/.test(r.file.split('/').pop()));
  if (suspects.length >= 2) {
    hints.push(`${col(C.cyan, 'ℹ')}  Multiple entry/config files in top results — consider splitting wiring from business logic.`);
  }

  return hints;
}

function renderTable(results, totalCommits, { repoPath, since, until, merges, ext, path: pathFilter }) {
  const dates = getDateRange(repoPath);
  const periodFrom = since ?? dates.first;
  const periodTo   = until ?? dates.last;

  const filters = [
    ext         && `ext=.${ext}`,
    pathFilter  && `path=${pathFilter}`,
    since       && `since=${since}`,
    until       && `until=${until}`,
    merges      && 'with merges',
  ].filter(Boolean);

  console.log();
  console.log(col(C.bold, `Code Churn Analysis`) + col(C.gray, ` — ${repoPath}`));
  console.log(col(C.dim, `Commits analyzed: ${totalCommits.toLocaleString()}  |  Period: ${periodFrom} → ${periodTo}`) +
    (filters.length ? col(C.dim, `  |  Filters: ${filters.join(', ')}`) : ''));
  console.log();

  if (!results.length) {
    console.log(col(C.yellow, 'No files found matching the given filters.'));
    console.log();
    return;
  }

  const maxChanges  = results[0].changes;
  const rankWidth   = String(results.length).length;
  const countWidth  = Math.max(7, String(maxChanges).length);

  const header = [
    col(C.bold, ' Rank'.padStart(rankWidth + 1)),
    col(C.bold, 'Changes'.padStart(countWidth)),
    col(C.bold, 'Bar'.padEnd(BAR_WIDTH + 2)),
    col(C.bold, 'File'),
  ].join('  ');

  console.log(header);
  console.log(col(C.dim, '─'.repeat(rankWidth + 2 + countWidth + 2 + BAR_WIDTH + 4 + 50)));

  results.forEach(({ file, changes }, i) => {
    const rank      = i + 1;
    const clr       = fileColor(rank, results.length);
    const rankStr   = col(clr, String(rank).padStart(rankWidth + 1));
    const countStr  = col(clr + C.bold, String(changes).padStart(countWidth));
    const barStr    = col(clr, bar(changes, maxChanges));
    const fileStr   = col(clr, file);

    console.log(`${rankStr}  ${countStr}  ${barStr}  ${fileStr}`);
  });

  console.log();

  const hints = smellHints(results, totalCommits);
  if (hints.length) {
    hints.forEach(h => console.log(h));
    console.log();
  }
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

  if (!existsSync(`${opts.repoPath}/.git`)) {
    process.stderr.write(`${col(C.red, 'Error:')} not a git repository: ${opts.repoPath}\n`);
    process.exit(1);
  }

  let results, totalCommits;
  try {
    const countArgs = [];
    if (!opts.merges) countArgs.push('--no-merges');
    if (opts.since)   countArgs.push(`--since=${opts.since}`);
    if (opts.until)   countArgs.push(`--until=${opts.until}`);

    totalCommits = countCommits(opts.repoPath, countArgs);
    results = analyze(opts.repoPath, opts);
  } catch (err) {
    process.stderr.write(`${col(C.red, 'Error:')} ${err.message}\n`);
    process.exit(1);
  }

  if (opts.json) {
    console.log(JSON.stringify({ totalCommits, files: results }, null, 2));
    return;
  }

  renderTable(results, totalCommits, opts);
}

main();
