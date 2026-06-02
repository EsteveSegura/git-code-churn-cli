import { extname } from 'node:path';
import { git } from './git.js';

const FUNCTIONS_TOP = 10;

export function analyzeFiles(repoPath, opts) {
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

export function analyzeFunctionChurn(repoPath, filePath, fns, opts) {
  const gitArgs = ['log', '-p', '--unified=0', '--pretty=format:%H'];
  if (!opts.merges) gitArgs.push('--no-merges');
  if (opts.since)   gitArgs.push(`--since=${opts.since}`);
  if (opts.until)   gitArgs.push(`--until=${opts.until}`);
  gitArgs.push('--', filePath);

  const raw    = git(repoPath, gitArgs);
  const counts = new Map(fns.map(f => [f.name, 0]));

  for (const line of raw.split('\n')) {
    const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!m) continue;

    const hunkStart = parseInt(m[1], 10);
    const hunkCount = m[2] !== undefined ? parseInt(m[2], 10) : 1;
    if (hunkCount === 0) continue;

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
