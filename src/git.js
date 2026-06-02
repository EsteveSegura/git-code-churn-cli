import { spawnSync } from 'node:child_process';

export function git(repoPath, gitArgs) {
  const result = spawnSync('git', ['-C', repoPath, ...gitArgs], {
    encoding: 'utf8',
    maxBuffer: 200 * 1024 * 1024,
  });
  if (result.error) throw new Error(`git not found: ${result.error.message}`);
  if (result.status !== 0) throw new Error(result.stderr?.trim() || 'git command failed');
  return result.stdout;
}

export function getDateRange(repoPath) {
  try {
    const first = git(repoPath, ['log', '--reverse', '--pretty=format:%ad', '--date=short']).split('\n')[0];
    const last  = git(repoPath, ['log', '-1', '--pretty=format:%ad', '--date=short']).trim();
    return { first, last };
  } catch {
    return { first: '?', last: '?' };
  }
}

export function countCommits(repoPath, extraArgs) {
  try {
    return parseInt(git(repoPath, ['rev-list', '--count', 'HEAD', ...extraArgs]).trim(), 10);
  } catch {
    return 0;
  }
}
