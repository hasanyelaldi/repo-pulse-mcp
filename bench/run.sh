#!/bin/bash
# Runs one benchmark question with Claude Code in one of two modes:
#   shell  - only the Bash tool, limited to read-only git and text utilities
#   pulse  - only the repo-pulse MCP server (local build), no built-in tools
#
# Usage: bench/run.sh <id> <repo-dir-name> <shell|pulse> <question>
# Repositories are expected in bench/repos/<name> (see bench/README.md).
set -euo pipefail
BENCH=$(cd "$(dirname "$0")" && pwd)
ROOT=$(dirname "$BENCH")
id=$1; repo=$BENCH/repos/$2; mode=$3; q=$4
mkdir -p "$BENCH/results"
out=$BENCH/results/$id-$mode.json

common=(--print --output-format json --model "${BENCH_MODEL:-sonnet}" --no-session-persistence
  --setting-sources project --strict-mcp-config)
cd "$repo"
if [ "$mode" = shell ]; then
  echo '{"mcpServers":{}}' > "$BENCH/results/.mcp-empty.json"
  claude "${common[@]}" --mcp-config "$BENCH/results/.mcp-empty.json" --tools Bash \
    --allowedTools 'Bash(git *)' 'Bash(sort *)' 'Bash(uniq *)' 'Bash(head *)' 'Bash(tail *)' \
    'Bash(awk *)' 'Bash(wc *)' 'Bash(grep *)' 'Bash(cut *)' \
    -- "$q" < /dev/null > "$out"
else
  printf '{"mcpServers":{"repo-pulse":{"command":"node","args":["%s/build/index.js","--repo","%s"]}}}' \
    "$ROOT" "$repo" > "$BENCH/results/.mcp-$2.json"
  claude "${common[@]}" --mcp-config "$BENCH/results/.mcp-$2.json" --tools "" \
    --allowedTools 'mcp__repo-pulse' \
    -- "$q" < /dev/null > "$out"
fi
echo "$id-$mode done"
