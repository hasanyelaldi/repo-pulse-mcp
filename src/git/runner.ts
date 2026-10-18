import { execFile } from 'node:child_process';
import { GitError } from '../errors.js';

/**
 * The only git subcommands this server may run. All of them are read-only.
 * Anything else is rejected before a process is spawned.
 */
export const ALLOWED_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'log',
  'rev-list',
  'rev-parse',
  'describe',
  'for-each-ref',
]);

export const GIT_TIMEOUT_MS = 15_000;
export const GIT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

// Options placed before the subcommand on every invocation.
const GLOBAL_ARGS = [
  '--no-pager',
  // Treat pathspecs literally: "*.ts" matches a file named "*.ts", not a glob.
  '--literal-pathspecs',
  // A repository's own config could point fsmonitor at an arbitrary program.
  '-c',
  'core.fsmonitor=false',
  // Print non-ASCII paths as-is instead of as quoted octal escapes.
  '-c',
  'core.quotePath=false',
];

function buildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    // Inherited GIT_DIR, GIT_WORK_TREE, etc. would redirect git away from the
    // allowlisted repository, so drop every GIT_* variable.
    if (!key.startsWith('GIT_')) env[key] = value;
  }
  return {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    // Never take optional locks (e.g. index refresh); we only read.
    GIT_OPTIONAL_LOCKS: '0',
    // Stable, English, parseable output regardless of the user's locale.
    LC_ALL: 'C',
  };
}

export type GitRunner = (repoPath: string, args: readonly string[]) => Promise<string>;

/**
 * Runs `git <args>` inside `repoPath` and resolves with stdout.
 *
 * Uses execFile with an argument array, so no shell is involved and arguments
 * are never re-parsed. The first argument must be an allowlisted subcommand.
 */
export const runGit: GitRunner = (repoPath, args) => {
  const subcommand = args[0];
  if (subcommand === undefined || !ALLOWED_SUBCOMMANDS.has(subcommand)) {
    return Promise.reject(new GitError(`git subcommand "${subcommand ?? ''}" is not allowed.`));
  }

  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...GLOBAL_ARGS, ...args],
      {
        cwd: repoPath,
        env: buildEnv(),
        encoding: 'utf8',
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_OUTPUT_BYTES,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout);
          return;
        }
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          reject(new GitError('git executable not found. Is git installed and on PATH?'));
        } else if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          reject(new GitError(`git ${subcommand} produced too much output. Narrow the query.`));
        } else if (error.killed) {
          reject(new GitError(`git ${subcommand} timed out after ${GIT_TIMEOUT_MS / 1000}s.`));
        } else {
          const detail = stderr.trim().split('\n')[0] ?? '';
          reject(new GitError(`git ${subcommand} failed${detail ? `: ${detail}` : '.'}`));
        }
      },
    );
  });
};
