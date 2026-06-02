# code-churn

A zero-config CLI that reads your git history and shows which files and functions change most often — a reliable proxy for code smells like God Objects, oversized controllers, and poor separation of concerns.

```
Code Churn Analysis — /your/repo
Commits analyzed: 782  |  Period: 2020-07-29 → 2026-05-29

 Rank  Changes  Bar                   File
───────────────────────────────────────────────────────────────────
    1      124  ████████████████████  src/container.js
    2      114  ██████████████████░░  src/infrastructure/config/index.js
    3      106  █████████████████░░░  src/index.js

⚠  src/container.js has 124 commits — likely a God Object or config hub.
⚠  Top 5 files account for 70% of all file changes — concentrated responsibility.
```

## Install

```bash
npm install -g git-code-churn-cli
```

Or run without installing:

```bash
npx git-code-churn-cli ./my-repo
```

## Usage

```
code-churn <repo-path> [options]

Options:
  --top <n>        Show top N files (default: 20, or 5 with --functions)
  --since <date>   Only commits after date      (e.g. 2024-01-01)
  --until <date>   Only commits before date
  --ext <ext>      Filter by extension          (e.g. .js or js)
  --path <prefix>  Filter by path prefix        (e.g. src/)
  --merges         Include merge commits         (excluded by default)
  --functions      Show function-level churn for top JS/MJS/CJS files
  --json           Output raw JSON
  -h, --help       Show this help
```

## Examples

**Basic file churn:**
```bash
code-churn ./my-repo
```

**Last 2 years, TypeScript only, top 10:**
```bash
code-churn ./my-repo --top 10 --since 2024-01-01 --ext ts
```

**Function-level churn for the top 3 most-churned files:**
```bash
code-churn ./my-repo --functions --top 3
```

**Focus on a specific directory:**
```bash
code-churn ./my-repo --functions --path src/domain/
```

**JSON output for piping or scripting:**
```bash
code-churn ./my-repo --json | jq '.files[0]'
```

## Function-level churn

With `--functions`, each file's top churned functions are shown below it:

```
  src/infrastructure/rest/social-auth-controller.js (86 file commits)
   Rank  Changes  Bar                   Function
  ──────────────────────────────────────────────────────────────
      1       57  ████████████████████  GET /auth/xsolla
      2       13  █████░░░░░░░░░░░░░░░  POST /auth/sign-in-with-email
      3        7  ██░░░░░░░░░░░░░░░░░░  POST /oauth/token
```

Detected patterns:
- `function foo() {}` — function declarations
- `const foo = () => {}` — arrow functions assigned to variables
- `class Foo { bar() {} }` — class methods (including `static`, `get`, `set`)
- `{ foo: () => {} }` — object properties with function values
- `this.foo = function() {}` / `module.exports.foo = () => {}` — member assignments
- `router.get('/path', handler)` — Express/Fastify route handlers, named as `METHOD /path`

> **Note:** function-level analysis uses the current file state as the reference for function boundaries. It is a heuristic — functions renamed or moved across commits may be undercounted. TypeScript (`.ts`) files are not yet supported.

## How it works

**File churn:** runs `git log --name-only` once and counts how many times each file appears across commits.

**Function churn:** parses the current file with [acorn](https://github.com/acornjs/acorn) to extract function names and their line ranges, then runs a single `git log -p --unified=0` per file and maps each diff hunk to the functions it overlaps. One git call per file — no per-function `git log -L` loop.

All analysis is **read-only** — the tool never modifies your repository.

## Reading the results

| Color | Meaning |
|-------|---------|
| 🔴 Red | Top 20% by change count — highest churn, most likely to need attention |
| 🟡 Yellow | Middle 30% |
| 🟢 Green | Bottom 50% |

**Smell hints** appear below the table when thresholds are crossed:
- A single file with >100 commits suggests a God Object or a central wiring file that absorbs all changes
- Top 5 files accounting for >40% of all file changes indicates concentrated responsibility
- High function churn (>30 commits) on a single function suggests it should be split

## Requirements

- Node.js ≥ 18
- git in PATH

## License

MIT
