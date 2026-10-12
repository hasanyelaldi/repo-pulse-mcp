#!/usr/bin/env node
// stdio entry point. The shebang lets npm expose the compiled file as an
// executable ("bin" in package.json); TypeScript preserves it in the output.
//
// IMPORTANT: stdout carries the MCP protocol (JSON-RPC). All logging goes to stderr.
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { parseRepoPaths, RepoRegistry, REPOS_ENV_VAR, resolveRepositories } from './config.js';
import { runGit } from './git/runner.js';
import { createServer, SERVER_NAME } from './server.js';

async function main(): Promise<void> {
  const paths = parseRepoPaths(process.argv.slice(2), process.env);
  if (paths.length === 0) {
    // Fail closed: never fall back to the current directory or anything implicit.
    throw new Error(
      `No repositories configured. Pass --repo <path> (repeatable) or set ${REPOS_ENV_VAR}.`,
    );
  }

  const registry = new RepoRegistry(await resolveRepositories(paths, runGit));
  const server = createServer({ registry, runGit });
  await server.connect(new StdioServerTransport());

  const names = registry.list().map((r) => `${r.name} (${r.path})`);
  console.error(`${SERVER_NAME}: serving ${names.length} repo(s): ${names.join(', ')}`);
}

main().catch((error: unknown) => {
  console.error(`${SERVER_NAME}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
