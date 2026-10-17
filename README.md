# repo-pulse-mcp

[![CI](https://github.com/hasanyelaldi/repo-pulse-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/hasanyelaldi/repo-pulse-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/repo-pulse-mcp)](https://www.npmjs.com/package/repo-pulse-mcp)
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

## Why repo-pulse?

There are already MCP servers for GitHub, GitLab and git itself, and coding agents with a shell
can run `git log` directly. repo-pulse does not try to replace them. It does a different job: it
**turns local git history into answers** and is **safe to auto-approve**.

|                                  | repo-pulse                   | GitHub / GitLab MCP        | Generic git MCP / shell |
| -------------------------------- | ---------------------------- | -------------------------- | ----------------------- |
| Returns                          | Aggregated insights          | Platform API objects       | Raw git output          |
| Can modify anything              | No, enforced by an allowlist | Usually yes (token scopes) | Yes                     |
| Needs a token or network         | No                           | Yes                        | No                      |
| Sees local and unpushed branches | Yes                          | No                         | Yes                     |
| Works without a hosting platform | Yes                          | No                         | Yes                     |
| Sees pull requests, issues, CI   | No                           | Yes                        | No                      |

What that means in practice:

- **One call instead of a pile of output.** Questions like "where is the churn?", "what goes into
  the release notes?" or "which branches are merged and stale?" need hundreds or thousands of
  lines of `git log --numstat` and careful counting. repo-pulse does the counting in code and
  returns small, deterministic JSON, which saves context and avoids arithmetic mistakes.
- **Read-only you can verify.** Every tool is annotated `readOnlyHint` and backed by a git
  subcommand allowlist (see [Security model](#security-model)), so a client can run it without
  asking for approval each time. You would not give the same permission to a shell or to a git
  server that can commit and push.
- **Useful where there is no shell.** Chat clients such as Claude Desktop cannot run `git`. With
  repo-pulse, an engineering manager or tech lead can ask about a repository directly.
- **Works with anything git can open.** It works offline and in air-gapped environments, on
  self-hosted or remote-less repositories, and it never returns author email addresses.

**Use it alongside a platform server, not instead of one.** Pair it with the GitHub or GitLab MCP
when you also need pull requests, issues or CI status. If you work in a coding agent that already
has a shell and you only need the occasional `git log`, you probably do not need repo-pulse.

## Features

| Kind     | Name                        | What it does                                                            |
| -------- | --------------------------- | ----------------------------------------------------------------------- |
| Tool     | `recent_activity`           | Commits from the last N days, filterable by author and path             |
| Tool     | `commit_search`             | Search commit messages for text, optionally by window, author and path  |
| Tool     | `file_history`              | One file's commits with line stats, following it across renames         |
| Tool     | `file_hotspots`             | Files ranked by how often they changed in a time window                 |
| Tool     | `change_coupling`           | File pairs that keep changing in the same commits (hidden dependencies) |
| Tool     | `release_notes_draft`       | Commits between two refs grouped by conventional-commit type + Markdown |
| Tool     | `compare_refs`              | Ahead/behind counts and commits between two branches, tags or commits   |
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

The package is published on npm, so there is nothing to clone or build. The server only serves
repositories you explicitly allow. Pass them as CLI arguments or an environment variable
(separated by `:` on macOS/Linux, `;` on Windows):

```bash
npx -y repo-pulse-mcp --repo ~/code/my-app --repo ~/code/my-lib
# or
REPO_PULSE_REPOS=~/code/my-app:~/code/my-lib npx -y repo-pulse-mcp
```

Without any configured repository the server refuses to start. It is also listed in the
[MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.hasanyelaldi/repo-pulse-mcp`.

### Claude Code

Run this inside the repository you want to ask about:

```bash
claude mcp add repo-pulse -- npx -y repo-pulse-mcp --repo "$PWD"
```

### Claude Desktop

Edit `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`,
Windows: `%APPDATA%\Claude\`) and restart Claude Desktop. Use absolute paths:

```json
{
  "mcpServers": {
    "repo-pulse": {
      "command": "npx",
      "args": ["-y", "repo-pulse-mcp", "--repo", "/absolute/path/to/your/repository"]
    }
  }
}
```

### From source

```bash
git clone https://github.com/hasanyelaldi/repo-pulse-mcp.git
cd repo-pulse-mcp
npm ci
npm run build
node build/index.js --repo /absolute/path/to/your/repository
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

### `commit_search`

| Input    | Type    | Default | Notes                                                       |
| -------- | ------- | ------- | ----------------------------------------------------------- |
| `query`  | string  | –       | Required. Literal, case-insensitive; matches subject + body |
| `days`   | integer | –       | 1–3650. Omit to search the whole history                    |
| `author` | string  | –       | Substring of the author name, matched literally             |
| `path`   | string  | –       | Repository-relative file or directory                       |
| `limit`  | integer | 20      | 1–100                                                       |

Output: `{ repo, query, windowDays, totalMatches, truncated, commits: [{ hash, shortHash, author, date, subject }] }`

### `file_history`

| Input   | Type    | Default | Notes                                          |
| ------- | ------- | ------- | ---------------------------------------------- |
| `path`  | string  | –       | Required. Repository-relative file, as at HEAD |
| `limit` | integer | 20      | 1–100                                          |

Output: `{ repo, path, commitCount, truncated, renamed, commits: [{ hash, shortHash, author, date, subject, path, additions, deletions }] }`

Renames are followed, so older commits report the path the file had at the time and `renamed` is
`true` when the listed commits span more than one path. Merge commits are skipped; `additions` and
`deletions` are `null` for binary files.

### `file_hotspots`

| Input     | Type     | Default | Notes                                                                                            |
| --------- | -------- | ------- | ------------------------------------------------------------------------------------------------ |
| `days`    | integer  | 90      | 1–3650                                                                                           |
| `path`    | string   | –       | Restrict to a subtree                                                                            |
| `exclude` | string[] | –       | Up to 20 globs to skip, e.g. `["*.lock", "dist/"]`. No `/` = any depth, trailing `/` = directory |
| `limit`   | integer  | 10      | 1–100                                                                                            |

Output: `{ repo, windowDays, commitsScanned, scanTruncated, filesChanged, hotspots: [{ path, changes, additions, deletions, authors, lastChanged }] }`

Merge commits are excluded and renames are not followed, so a renamed file starts fresh. Use
`file_history` to trace a single file across renames.

### `change_coupling`

| Input               | Type     | Default | Notes                                                  |
| ------------------- | -------- | ------- | ------------------------------------------------------ |
| `days`              | integer  | 90      | 1–3650                                                 |
| `file`              | string   | –       | Only pairs that include this file                      |
| `path`              | string   | –       | Restrict to a subtree                                  |
| `exclude`           | string[] | –       | Up to 20 globs to skip, same syntax as `file_hotspots` |
| `minShared`         | integer  | 2       | Minimum shared commits for a pair to be listed         |
| `maxFilesPerCommit` | integer  | 30      | Commits touching more files are skipped                |
| `limit`             | integer  | 10      | 1–100                                                  |

Output: `{ repo, windowDays, commitsScanned, scanTruncated, commitsSkipped, pairCount, pairs: [{ fileA, fileB, sharedCommits, revisionsA, revisionsB, degree }] }`

`degree` is the number of shared commits as a percentage of the average number of commits that
touched each file: 100 means the two files always change together. A high degree between files
that do not import each other usually points to a hidden dependency (duplicated logic, a config
or fixture that must be kept in sync). Large commits such as bulk renames or formatting runs are
skipped because they would couple every file they touch. Merge commits are excluded and renames
are not followed.

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

### `compare_refs`

| Input   | Type    | Default | Notes                                          |
| ------- | ------- | ------- | ---------------------------------------------- |
| `base`  | string  | –       | Required. Ref to compare against (e.g. `main`) |
| `head`  | string  | `HEAD`  | Ref to compare                                 |
| `limit` | integer | 20      | 1–100, applies to each commit list separately  |

Output: `{ repo, base, head, baseCommit, headCommit, ahead, behind, status, truncated, aheadCommits: [{ hash, shortHash, author, date, subject }], behindCommits: [...] }`

`ahead` counts commits reachable from `head` but not `base`, `behind` the reverse. `status` is
`identical`, `ahead`, `behind` or `diverged`. Both refs go through the same validation as
`release_notes_draft`, and the counts include merge commits.

### `stale_branches`

| Input           | Type    | Default | Notes                                    |
| --------------- | ------- | ------- | ---------------------------------------- |
| `days`          | integer | 30      | Minimum age of the latest commit         |
| `includeRemote` | boolean | false   | Also list remote-tracking branches       |
| `mergedOnly`    | boolean | false   | Only branches already merged into `HEAD` |
| `limit`         | integer | 50      | 1–200                                    |

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

**Releasing.** Bump the version in `package.json`, `server.json` (both `version` fields) and
`SERVER_VERSION` in `src/server.ts` (a unit test fails if they differ), merge, then push a tag:
`git tag v0.2.0 && git push origin v0.2.0`. The release workflow runs the full check, publishes
to npm with provenance and registers the new version in the MCP Registry. It needs an
`NPM_TOKEN` repository secret. If only the registry step fails, run the workflow manually
(`gh workflow run release.yml`): it skips npm and retries the registry.

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
- Possible next steps: an HTTP transport for team use, per-directory ownership stats.

## License

[MIT](LICENSE)
