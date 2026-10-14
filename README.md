# repo-pulse-mcp

[![CI](https://github.com/hasanyelaldi/repo-pulse-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/hasanyelaldi/repo-pulse-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A **read-only [Model Context Protocol](https://modelcontextprotocol.io) server** that gives an AI
assistant insight into local git repositories, so it can answer questions like:

- _"What changed since the last release?"_
- _"Which files change the most? Where is the churn?"_
- _"Which branches look stale, and which are already merged?"_
- _"Draft release notes for v0.3.0."_
- _"Write this week's engineering update."_

It runs locally over stdio, needs nothing but Node.js and git, and never modifies a repository.

It is platform-agnostic: it works with any local git repository, whether it was cloned from GitHub,
GitLab, Bitbucket or anywhere else, or has no remote at all. It only reads local git history and
never contacts a hosting service, so platform data such as pull requests, issues or CI status is out
of scope.

<!-- SCREENSHOT / GIF: Claude Desktop answering "What changed since the last release?"
     using release_notes_draft. Save as docs/demo.gif and uncomment the line below. -->
<!-- ![Demo](docs/demo.gif) -->

## Features

| Kind     | Name                        | What it does                                                            |
| -------- | --------------------------- | ----------------------------------------------------------------------- |
| Tool     | `recent_activity`           | Commits from the last N days, filterable by author and path             |
| Tool     | `file_hotspots`             | Files ranked by how often they changed in a time window                 |
| Tool     | `release_notes_draft`       | Commits between two refs grouped by conventional-commit type + Markdown |
| Tool     | `stale_branches`            | Branches with no commits for N days, with "already merged" flag         |
| Tool     | `contributor_summary`       | Commits per author in a time window                                     |
| Resource | `repo://{name}/overview`    | Current branch, last commit, latest tag, commit/branch/tag counts       |
| Prompt   | `weekly_engineering_update` | Guides the model to gather data with the tools and write an update      |

All tools are annotated `readOnlyHint: true`, declare an `outputSchema`, and return both
`structuredContent` and a JSON text block for older clients.

## Requirements

- Node.js **22.12+**
- git **2.24+** (for `--end-of-options`)

## Installation

```bash
git clone https://github.com/hasanyelaldi/repo-pulse-mcp.git
cd repo-pulse-mcp
npm ci
npm run build
```

The server only serves repositories you explicitly allow. Pass them as CLI arguments or an
environment variable (separated by `:` on macOS/Linux, `;` on Windows):

```bash
node build/index.js --repo ~/code/my-app --repo ~/code/my-lib
# or
REPO_PULSE_REPOS=~/code/my-app:~/code/my-lib node build/index.js
```

Without any configured repository the server refuses to start.

### Claude Desktop

Edit `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`,
Windows: `%APPDATA%\Claude\`) and restart Claude Desktop. Use absolute paths:

```json
{
  "mcpServers": {
    "repo-pulse": {
      "command": "node",
      "args": [
        "/absolute/path/to/repo-pulse-mcp/build/index.js",
        "--repo",
        "/absolute/path/to/your/repository"
      ]
    }
  }
}
```

### Claude Code

```bash
claude mcp add repo-pulse -- node /absolute/path/to/repo-pulse-mcp/build/index.js --repo "$PWD"
```

### Podman / Docker

```bash
podman build -t repo-pulse-mcp .
podman run -i --rm \
  -v "$PWD:/repos/project:ro" \
  -e REPO_PULSE_REPOS=/repos/project \
  repo-pulse-mcp
```

The repository is mounted read-only. On SELinux hosts (Fedora, RHEL) add `,Z` to the volume
options. Replace `podman` with `docker` if you prefer; the image uses no Docker-specific features.
For an MCP client, use `podman` as the `command` and the rest as `args`.

## Example conversations

> **You:** What changed since the last release?
>
> **Assistant** _(calls `release_notes_draft` with defaults: latest tag → HEAD)_: Since **v0.2.0**
> there are 14 commits. One breaking change: the config file moved to `repo-pulse.json`. New
> features: an author filter for activity and branch merge detection. Three bug fixes, mostly
> around empty repositories. Here's a Markdown draft you can paste into the GitHub release: …

> **You:** Where has most of the work happened this quarter? Anything risky?
>
> **Assistant** _(calls `file_hotspots` with `days: 90`)_: `src/core/insights.ts` changed in 23
> commits by 3 people, far more than anything else. That's a good candidate for splitting up or
> adding tests…

> **You:** Can we clean up some branches?
>
> **Assistant** _(calls `stale_branches` with `days: 30`)_: 6 branches haven't seen a commit in 30+
> days. 4 of them are already merged into `main` and are safe to delete: …

> **You:** _(selects the `weekly_engineering_update` prompt)_
>
> **Assistant** _(calls `recent_activity`, `contributor_summary`, `file_hotspots`, `stale_branches`)_:
> **Highlights** — …

## Tool reference

Every tool accepts an optional `repo` argument: a repository **name** (the directory name, shown
in the overview resource) or its absolute path. It defaults to the first configured repository.

### `recent_activity`

| Input    | Type    | Default | Notes                                           |
| -------- | ------- | ------- | ----------------------------------------------- |
| `days`   | integer | 7       | 1–3650                                          |
| `author` | string  | –       | Substring of the author name, matched literally |
| `path`   | string  | –       | Repository-relative file or directory           |
| `limit`  | integer | 50      | 1–200                                           |

Output: `{ repo, windowDays, totalCommits, truncated, commits: [{ hash, shortHash, author, date, subject }] }`

### `file_hotspots`

| Input     | Type     | Default | Notes                                                                                            |
| --------- | -------- | ------- | ------------------------------------------------------------------------------------------------ |
| `days`    | integer  | 90      | 1–3650                                                                                           |
| `path`    | string   | –       | Restrict to a subtree                                                                            |
| `exclude` | string[] | –       | Up to 20 globs to skip, e.g. `["*.lock", "dist/"]`. No `/` = any depth, trailing `/` = directory |
| `limit`   | integer  | 10      | 1–100                                                                                            |

Output: `{ repo, windowDays, commitsScanned, scanTruncated, filesChanged, hotspots: [{ path, changes, additions, deletions, authors, lastChanged }] }`

Merge commits are excluded and renames are not followed, so a renamed file starts fresh.

### `release_notes_draft`

| Input  | Type   | Default                | Notes                                 |
| ------ | ------ | ---------------------- | ------------------------------------- |
| `from` | string | latest tag before `to` | Exclusive. Tag, branch or commit hash |
| `to`   | string | `HEAD`                 | Inclusive                             |

Output: `{ repo, from, to, commitCount, truncated, sections: [{ key, title, entries: [{ shortHash, scope, description, author }] }], markdown }`

Sections, in order: Breaking Changes, Features, Bug Fixes, Performance, Refactoring,
Documentation, Tests, Build System, Continuous Integration, Chores, Reverts, Other Changes.
A commit is breaking if its header has `!` (`feat!: …`) or its body has a `BREAKING CHANGE:`
footer; breaking commits also appear in their type section. Merge commits are skipped.

### `stale_branches`

| Input           | Type    | Default | Notes                              |
| --------------- | ------- | ------- | ---------------------------------- |
| `days`          | integer | 30      | Minimum age of the latest commit   |
| `includeRemote` | boolean | false   | Also list remote-tracking branches |
| `limit`         | integer | 50      | 1–200                              |

Output: `{ repo, thresholdDays, totalBranches, staleCount, branches: [{ name, lastCommitDate, lastAuthor, daysSinceLastCommit, mergedIntoHead }] }`

### `contributor_summary`

| Input           | Type    | Default | Notes                 |
| --------------- | ------- | ------- | --------------------- |
| `days`          | integer | 30      | 1–3650                |
| `includeMerges` | boolean | false   | Count merges too      |
| `path`          | string  | –       | Restrict to a subtree |
| `limit`         | integer | 20      | 1–100                 |

Output: `{ repo, windowDays, totalCommits, scanTruncated, contributorCount, contributors: [{ author, commits, firstCommit, lastCommit }] }`

### Resource: `repo://{name}/overview`

One resource per configured repository (listed via `resources/list`, name completion supported):

```json
{
  "name": "my-app",
  "path": "/home/me/code/my-app",
  "currentBranch": "main",
  "detachedHead": false,
  "lastCommit": { "hash": "…", "shortHash": "1a2b3c4", "author": "…", "date": "…", "subject": "…" },
  "latestTag": "v0.2.0",
  "commitCount": 412,
  "branchCount": 7,
  "tagCount": 9
}
```

### Prompt: `weekly_engineering_update`

Arguments (strings, both optional): `repo`, `days` (default `7`). Produces a user message that
tells the model which tools to call and how to structure a short stakeholder update.

## Security model

The server is designed so that a confused or manipulated model cannot do damage:

- **Strictly read-only.** git runs through a single function that only allows `log`, `rev-list`,
  `rev-parse`, `describe` and `for-each-ref`. Anything else is rejected before a process starts.
- **No shell, ever.** git is started with `child_process.execFile` and an argument array, so
  arguments are never interpreted by a shell.
- **Repository allowlist.** Only repositories passed via `--repo` / `REPO_PULSE_REPOS` are
  served. Paths are canonicalized with `realpath` (symlinks resolved) at startup and compared
  exactly; unknown repositories get the same error whether or not they exist on disk. If nothing
  is configured, the server does not start (fail closed).
- **Input validation.** All inputs go through zod schemas with bounds. Refs must look like a
  branch, tag, hash or `~N`/`^N` suffix: no leading `-`, no `..` ranges, no `@{}` or `:` syntax,
  and they are passed after `--end-of-options`, then resolved with `rev-parse --verify`. Paths
  must be relative without `..` segments and are passed after `--` with `--literal-pathspecs`
  (no globbing). Author filters use `--fixed-strings`, so they are not regexes.
- **Bounded work.** Result counts are capped per tool, scans stop at 5,000 commits, git output is
  capped at 16 MB, and every git call times out after 15 s. Truncation is reported in the output.
- **Hardened git environment.** Inherited `GIT_*` variables (e.g. `GIT_DIR`) are dropped,
  prompts are disabled, optional locks are off, `core.fsmonitor` is forced off (a repository's
  own config could otherwise make git run a program), and external diff/textconv drivers are
  disabled where diffs are computed.
- **Less personal data.** Only author names are returned, never email addresses.

**Out of scope:** the server trusts the git binary on `PATH` and the repositories you allowlist.
It is a local developer tool; it has no network transport and no authentication.

## Architecture

```
src/
├── index.ts              # stdio entry point: config → registry → server → transport
├── server.ts             # MCP layer: tools, resource and prompt with zod schemas
├── config.ts             # --repo / REPO_PULSE_REPOS parsing, repo allowlist (RepoRegistry)
├── errors.ts             # InputError (safe to show) and GitError
├── core/
│   ├── insights.ts       # one method per feature: builds git args, aggregates results
│   └── release-notes.ts  # pure conventional-commit parsing, grouping and Markdown
└── git/
    ├── runner.ts         # the only place that spawns processes (allowlist, limits, env)
    ├── parsers.ts        # pure parsers for git output (no I/O)
    └── validation.ts     # ref / path / author validation
```

Design notes:

- **Process I/O is isolated from parsing.** `runner.ts` is the only module that spawns
  processes; `parsers.ts` and `release-notes.ts` are pure functions tested with string fixtures.
- **Unambiguous output format.** git output uses ASCII unit (`0x1f`) and record (`0x1e`)
  separators instead of tabs or newlines, which can appear in commit subjects and file names.
- **Testable composition.** `createServer()` takes its dependencies (allowlist, git runner,
  clock) as arguments, so tests connect it to an in-memory transport with a fixed "now".
- **Errors become tool results.** Validation and git failures surface as `isError: true` tool
  results with an actionable message, so the model can correct itself instead of the session
  failing.
- **stdout is sacred.** It carries JSON-RPC, so logging goes to stderr and ESLint forbids
  `console.log`.

Built on the official MCP TypeScript SDK v2 (`@modelcontextprotocol/server`).

## Development

```bash
npm ci
npm run dev -- --repo .     # run from source with tsx
npm test                    # unit + integration tests (vitest)
npm run lint                # ESLint
npm run format              # Prettier
npm run typecheck
npm run build               # compile to build/
npm run check               # everything CI runs
npm run inspect             # build first; opens MCP Inspector against this repository
```

**Tests.** Unit tests cover the parsers, validation, config parsing and release-notes grouping.
Integration tests create a temporary git repository with a scripted history (fictional authors,
fixed dates) and exercise every feature, both directly and end to end through a real MCP client
over an in-memory transport, including the security checks.

**MCP Inspector.** `npm run build && npm run inspect` opens the Inspector web UI connected to this
repository. For scripted checks, the CLI mode works too:

```bash
npx @modelcontextprotocol/inspector --cli node build/index.js -e REPO_PULSE_REPOS="$PWD" \
  --method tools/call --tool-name release_notes_draft
```

## Limitations and ideas

- Activity, hotspot and contributor tools look at commits reachable from `HEAD`; work on unmerged
  branches is not counted.
- Renames are not followed in `file_hotspots`.
- Possible next steps: an HTTP transport for team use, per-directory ownership stats,
  a `compare_refs` tool.

## License

[MIT](LICENSE)
