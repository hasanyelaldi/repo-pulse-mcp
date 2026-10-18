import { realpath } from 'node:fs/promises';
import { basename, delimiter, isAbsolute, resolve } from 'node:path';
import { InputError } from './errors.js';
import type { GitRunner } from './git/runner.js';

export const REPOS_ENV_VAR = 'REPO_PULSE_REPOS';

export interface Repository {
  /** Short, unique name clients can use instead of the full path. */
  name: string;
  /** Canonical absolute path of the working tree root. */
  path: string;
}

/**
 * Collects repository paths from `--repo <path>` / `--repo=<path>` CLI
 * arguments, plain positional arguments (`repo-pulse-mcp ~/a ~/b`, the form
 * container catalogs pass mounted paths in) and the {@link REPOS_ENV_VAR}
 * environment variable (entries separated by the platform path delimiter,
 * ":" on macOS/Linux). Other flags are ignored.
 */
export function parseRepoPaths(argv: readonly string[], env: NodeJS.ProcessEnv): string[] {
  const paths: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--repo') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--repo requires a path argument.');
      }
      paths.push(value);
      i++;
    } else if (arg.startsWith('--repo=')) {
      paths.push(arg.slice('--repo='.length));
    } else if (!arg.startsWith('-')) {
      paths.push(arg);
    }
  }
  for (const entry of (env[REPOS_ENV_VAR] ?? '').split(delimiter)) {
    if (entry.trim().length > 0) paths.push(entry.trim());
  }
  return paths.filter((p) => p.length > 0);
}

function uniqueName(path: string, taken: Set<string>): string {
  const base = basename(path) || 'repo';
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
  taken.add(name);
  return name;
}

/**
 * Turns configured paths into canonical repositories. Fails fast if a path
 * does not exist or is not inside a git working tree; a misconfiguration is
 * better reported at startup than on the first tool call.
 */
export async function resolveRepositories(
  paths: readonly string[],
  runGit: GitRunner,
): Promise<Repository[]> {
  const repos: Repository[] = [];
  const seen = new Set<string>();
  const names = new Set<string>();

  for (const raw of paths) {
    let real: string;
    try {
      real = await realpath(resolve(raw));
    } catch {
      throw new Error(`Configured repository path does not exist: ${raw}`);
    }
    let topLevel: string;
    try {
      topLevel = (await runGit(real, ['rev-parse', '--show-toplevel'])).trim();
    } catch {
      throw new Error(`Configured path is not a git working tree: ${raw}`);
    }
    const canonical = await realpath(topLevel);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    repos.push({ name: uniqueName(canonical, names), path: canonical });
  }
  return repos;
}

/** The allowlist of repositories. Every tool call resolves its repo here. */
export class RepoRegistry {
  constructor(private readonly repos: readonly Repository[]) {
    if (repos.length === 0) {
      throw new Error('RepoRegistry needs at least one repository.');
    }
  }

  list(): readonly Repository[] {
    return this.repos;
  }

  /**
   * Resolves a repository by name or absolute path. Without input, returns
   * the first configured repository. Anything not on the allowlist is
   * rejected with the same message, whether or not it exists on disk.
   */
  async resolve(input?: string): Promise<Repository> {
    if (input === undefined || input.trim() === '') {
      return this.repos[0] as Repository;
    }
    const byName = this.repos.find((r) => r.name === input);
    if (byName) return byName;

    if (isAbsolute(input)) {
      const real = await realpath(input).catch(() => null);
      const byPath = real ? this.repos.find((r) => r.path === real) : undefined;
      if (byPath) return byPath;
    }
    const known = this.repos.map((r) => r.name).join(', ');
    throw new InputError(`Repository "${input}" is not in the allowlist. Available: ${known}.`);
  }
}
