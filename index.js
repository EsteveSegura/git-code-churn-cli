#!/usr/bin/env node
import { existsSync }                                           from 'node:fs';
import { resolve, extname, join }                              from 'node:path';
import { countCommits }                                        from './src/git.js';
import { analyzeFiles, analyzeFunctionChurn }                  from './src/analyze.js';
import { extractFunctions, PARSEABLE_EXTS }                    from './src/ast.js';
import { col, C, HELP, printHeader, printFileTable,
         printFunctionSection, printSmellHints }               from './src/render.js';

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

  if (args.top === null) args.top = args.functions ? 5 : 20;
  return args;
}

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

  if (opts.functions) {
    const fnResultsMap = {};

    for (const { file } of fileResults) {
      const ext = extname(file).replace(/^\./, '');
      if (!PARSEABLE_EXTS.has(ext)) { fnResultsMap[file] = []; continue; }

      const absPath      = join(opts.repoPath, file);
      const fns          = existsSync(absPath) ? extractFunctions(absPath) : [];
      fnResultsMap[file] = fns.length ? analyzeFunctionChurn(opts.repoPath, file, fns, opts) : [];
    }

    if (opts.json) {
      console.log(JSON.stringify({
        totalCommits,
        files: fileResults.map(r => ({ ...r, functions: fnResultsMap[r.file] ?? [] })),
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

  if (opts.json) {
    console.log(JSON.stringify({ totalCommits, files: fileResults }, null, 2));
    return;
  }

  printHeader(opts.repoPath, totalCommits, opts);
  printFileTable(fileResults);
  printSmellHints(fileResults, {}, totalCommits);
}

main();
