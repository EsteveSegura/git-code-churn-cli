import { extname } from 'node:path';
import { getDateRange } from './git.js';
import { PARSEABLE_EXTS } from './ast.js';

export const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  green:  '\x1b[32m',
  cyan:   '\x1b[36m',
  gray:   '\x1b[90m',
};

export const col = (code, str) => `${code}${str}${C.reset}`;

export const HELP = `
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

export function printHeader(repoPath, totalCommits, opts) {
  const { first, last } = getDateRange(repoPath);
  const from = opts.since ?? first;
  const to   = opts.until ?? last;

  const filters = [
    opts.ext       && `ext=.${opts.ext}`,
    opts.path      && `path=${opts.path}`,
    opts.since     && `since=${opts.since}`,
    opts.until     && `until=${opts.until}`,
    opts.merges    && 'with merges',
    opts.functions && 'function churn',
  ].filter(Boolean);

  console.log();
  console.log(col(C.bold, 'Code Churn Analysis') + col(C.gray, ` — ${repoPath}`));
  console.log(
    col(C.dim, `Commits analyzed: ${totalCommits.toLocaleString()}  |  Period: ${from} → ${to}`) +
    (filters.length ? col(C.dim, `  |  ${filters.join(', ')}`) : '')
  );
}

export function printFileTable(results) {
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

export function printFunctionSection(filePath, fileChanges, fnResults) {
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

export function printSmellHints(fileResults, fnResultsMap, totalCommits) {
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
