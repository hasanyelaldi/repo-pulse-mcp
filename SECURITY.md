# Security policy

repo-pulse is meant to be safe to auto-approve: it only reads local git history through an
allowlist of read-only git subcommands. The [Security model](README.md#security-model) describes
the guarantees in detail.

## Reporting a vulnerability

Please report vulnerabilities privately through
[GitHub's private vulnerability reporting](https://github.com/hasanyelaldi/repo-pulse-mcp/security/advisories/new),
not in a public issue. Examples of what counts:

- a way to make the server write to a repository, run a git subcommand outside the allowlist or
  run any other program
- reading a repository that was not configured, or files outside a configured repository
- author email addresses or other data the README says is never returned showing up in tool
  output

You can expect a first response within a week. Fixes are released as a new npm version, and the
advisory is published once a fixed version is available.

## Supported versions

Only the latest release on npm receives security fixes.
