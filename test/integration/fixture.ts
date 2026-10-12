import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** Fixed "now" for all integration tests, so day-based windows are deterministic. */
export const NOW = new Date('2026-01-15T12:00:00Z');

const DAY_MS = 24 * 60 * 60 * 1000;

// Fictional people; example.com is reserved for documentation.
const PEOPLE = {
  alice: { name: 'Alice Example', email: 'alice@example.com' },
  bob: { name: 'Bob Example', email: 'bob@example.com' },
  carol: { name: 'Carol Example', email: 'carol@example.com' },
} as const;

type Person = keyof typeof PEOPLE;

export interface TempRepo {
  path: string;
  cleanup: () => Promise<void>;
}

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      // Isolate from the developer's own git config (signing, hooks, templates...).
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      ...env,
    },
  });
}

async function commit(
  repo: string,
  opts: {
    daysAgo: number;
    by: Person;
    subject: string;
    body?: string;
    files: Record<string, string>;
  },
): Promise<void> {
  for (const [file, content] of Object.entries(opts.files)) {
    const full = join(repo, file);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  git(repo, ['add', '--all']);
  const date = new Date(NOW.getTime() - opts.daysAgo * DAY_MS).toISOString();
  const person = PEOPLE[opts.by];
  const message = opts.body ? `${opts.subject}\n\n${opts.body}` : opts.subject;
  git(repo, ['commit', '--quiet', '--message', message], {
    GIT_AUTHOR_NAME: person.name,
    GIT_AUTHOR_EMAIL: person.email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: person.name,
    GIT_COMMITTER_EMAIL: person.email,
    GIT_COMMITTER_DATE: date,
  });
}

/**
 * Creates this history (days before {@link NOW}):
 *
 *   40  chore: initial commit              alice   (tag v0.1.0)
 *   35  feat: risky experiment             bob     (only on feature/old-experiment)
 *   20  feat(api): add users endpoint      alice   (also tip of merged-branch)
 *   10  fix: handle empty input            bob
 *    5  feat!: drop legacy config          alice
 *    3  docs: update readme                carol
 *    2  refactor(parser): simplify         alice   (BREAKING CHANGE footer)
 *    1  Update dependencies                bob
 */
export async function createFixtureRepo(): Promise<TempRepo> {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'repo-pulse-test-')));
  git(path, ['init', '--quiet', '--initial-branch=main']);

  await commit(path, {
    daysAgo: 40,
    by: 'alice',
    subject: 'chore: initial commit',
    files: { 'README.md': '# Demo\n', 'src/app.ts': 'export const v = 1;\n' },
  });
  git(path, ['tag', 'v0.1.0']);

  git(path, ['checkout', '--quiet', '-b', 'feature/old-experiment']);
  await commit(path, {
    daysAgo: 35,
    by: 'bob',
    subject: 'feat: risky experiment',
    files: { 'src/experiment.ts': 'export {};\n' },
  });
  git(path, ['checkout', '--quiet', 'main']);

  await commit(path, {
    daysAgo: 20,
    by: 'alice',
    subject: 'feat(api): add users endpoint',
    files: { 'src/api.ts': 'export const users = [];\n' },
  });
  git(path, ['branch', 'merged-branch']);

  await commit(path, {
    daysAgo: 10,
    by: 'bob',
    subject: 'fix: handle empty input',
    files: { 'src/app.ts': 'export const v = 2;\n' },
  });
  await commit(path, {
    daysAgo: 5,
    by: 'alice',
    subject: 'feat!: drop legacy config',
    files: { 'src/app.ts': 'export const v = 3;\n', 'config.json': '{}\n' },
  });
  await commit(path, {
    daysAgo: 3,
    by: 'carol',
    subject: 'docs: update readme',
    files: { 'README.md': '# Demo\n\nUsage notes.\n' },
  });
  await commit(path, {
    daysAgo: 2,
    by: 'alice',
    subject: 'refactor(parser): simplify',
    body: 'BREAKING CHANGE: parse() now returns an array',
    files: { 'src/app.ts': 'export const v = 4;\n' },
  });
  await commit(path, {
    daysAgo: 1,
    by: 'bob',
    subject: 'Update dependencies',
    files: { 'package.json': '{ "name": "demo" }\n' },
  });

  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

/** Creates an empty directory that is not a git repository. */
export async function createPlainDir(): Promise<TempRepo> {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'repo-pulse-plain-')));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}
