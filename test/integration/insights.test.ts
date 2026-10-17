import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveRepositories } from '../../src/config.js';
import { RepoInsights } from '../../src/core/insights.js';
import { GitError, InputError } from '../../src/errors.js';
import { runGit } from '../../src/git/runner.js';
import {
  createCouplingRepo,
  createFixtureRepo,
  createPlainDir,
  createRenameRepo,
  NOW,
  type TempRepo,
} from './fixture.js';

let repo: TempRepo;
let insights: RepoInsights;

beforeAll(async () => {
  repo = await createFixtureRepo();
  insights = new RepoInsights({ runGit, now: () => NOW });
});

afterAll(async () => {
  await repo?.cleanup();
});

describe('runGit', () => {
  it('refuses subcommands outside the allowlist', async () => {
    await expect(runGit(repo.path, ['push'])).rejects.toThrow(GitError);
    await expect(runGit(repo.path, ['config', 'user.name', 'x'])).rejects.toThrow(/not allowed/);
    await expect(runGit(repo.path, [])).rejects.toThrow(GitError);
  });
});

describe('resolveRepositories', () => {
  it('canonicalizes paths, dedupes and names repos', async () => {
    const repos = await resolveRepositories([repo.path, `${repo.path}/src`], runGit);
    expect(repos).toHaveLength(1);
    expect(repos[0]?.path).toBe(repo.path);
  });

  it('fails fast for missing paths and non-repositories', async () => {
    const plain = await createPlainDir();
    try {
      await expect(resolveRepositories(['/does/not/exist'], runGit)).rejects.toThrow(
        /does not exist/,
      );
      await expect(resolveRepositories([plain.path], runGit)).rejects.toThrow(
        /not a git working tree/,
      );
    } finally {
      await plain.cleanup();
    }
  });
});

describe('recentActivity', () => {
  it('returns commits in the window, newest first', async () => {
    const result = await insights.recentActivity(repo.path, { days: 7, limit: 50 });
    expect(result.commits.map((c) => c.subject)).toEqual([
      'Update dependencies',
      'refactor(parser): simplify',
      'docs: update readme',
      'feat!: drop legacy config',
    ]);
    expect(result.totalCommits).toBe(4);
    expect(result.truncated).toBe(false);
  });

  it('filters by author as a fixed string', async () => {
    const result = await insights.recentActivity(repo.path, { days: 30, limit: 50, author: 'Bob' });
    expect(result.commits.map((c) => c.subject)).toEqual([
      'Update dependencies',
      'fix: handle empty input',
    ]);
    // Regex metacharacters must not act as a wildcard.
    const none = await insights.recentActivity(repo.path, { days: 30, limit: 50, author: 'B.b' });
    expect(none.commits).toEqual([]);
  });

  it('filters by path and reports truncation', async () => {
    const result = await insights.recentActivity(repo.path, {
      days: 30,
      limit: 2,
      path: 'src/app.ts',
    });
    expect(result.commits).toHaveLength(2);
    expect(result.totalCommits).toBe(3);
    expect(result.truncated).toBe(true);
  });

  it('rejects unsafe paths', async () => {
    await expect(
      insights.recentActivity(repo.path, { days: 7, limit: 5, path: '../etc' }),
    ).rejects.toThrow(InputError);
  });
});

describe('fileHotspots', () => {
  it('ranks files by number of changing commits', async () => {
    const result = await insights.fileHotspots(repo.path, { days: 30, limit: 3 });
    expect(result.commitsScanned).toBe(6);
    expect(result.hotspots[0]).toMatchObject({ path: 'src/app.ts', changes: 3, authors: 2 });
    expect(result.hotspots).toHaveLength(3);
    expect(result.filesChanged).toBe(5);
  });

  it('leaves out files matching exclude patterns', async () => {
    const result = await insights.fileHotspots(repo.path, {
      days: 30,
      limit: 10,
      exclude: ['*.md'],
    });
    expect(result.hotspots.map((h) => h.path)).not.toContain('README.md');
    expect(result.filesChanged).toBe(4);
  });

  it('rejects malformed exclude patterns', async () => {
    await expect(
      insights.fileHotspots(repo.path, { days: 30, limit: 3, exclude: [''] }),
    ).rejects.toThrow(InputError);
  });
});

describe('releaseNotesDraft', () => {
  it('defaults "from" to the latest tag and groups commits', async () => {
    const result = await insights.releaseNotesDraft(repo.path, { to: 'HEAD' });
    expect(result.from).toBe('v0.1.0');
    expect(result.commitCount).toBe(6);
    expect(result.sections.map((s) => s.key)).toEqual([
      'breaking',
      'feat',
      'fix',
      'refactor',
      'docs',
      'other',
    ]);
    expect(result.sections[0]?.entries.map((e) => e.description)).toEqual([
      'simplify',
      'drop legacy config',
    ]);
    expect(result.markdown).toContain('## Changes from v0.1.0 to HEAD');
    expect(result.markdown).toContain('**api:** add users endpoint');
  });

  it('supports explicit refs', async () => {
    const result = await insights.releaseNotesDraft(repo.path, {
      from: 'merged-branch',
      to: 'HEAD~2',
    });
    expect(result.sections.flatMap((s) => s.entries.map((e) => e.description))).toEqual(
      expect.arrayContaining(['handle empty input', 'drop legacy config', 'update readme']),
    );
    expect(result.commitCount).toBe(3);
  });

  it('uses the previous tag when "to" is itself tagged', async () => {
    const result = await insights.releaseNotesDraft(repo.path, { to: 'v0.1.0' });
    expect(result.from).toBeNull();
    expect(result.commitCount).toBe(1);
  });

  it('rejects unknown and malicious refs', async () => {
    await expect(insights.releaseNotesDraft(repo.path, { to: 'nope' })).rejects.toThrow(
      /Unknown ref/,
    );
    await expect(insights.releaseNotesDraft(repo.path, { to: '--output=/tmp/x' })).rejects.toThrow(
      InputError,
    );
    await expect(
      insights.releaseNotesDraft(repo.path, { from: 'a..b', to: 'HEAD' }),
    ).rejects.toThrow(InputError);
  });
});

describe('staleBranches', () => {
  it('can be limited to branches already merged into HEAD', async () => {
    const result = await insights.staleBranches(repo.path, {
      days: 14,
      limit: 50,
      includeRemote: false,
      mergedOnly: true,
    });
    expect(result.totalBranches).toBe(3);
    expect(result.staleCount).toBe(1);
    expect(result.branches).toEqual([
      expect.objectContaining({ name: 'merged-branch', mergedIntoHead: true }),
    ]);
  });

  it('lists old branches with merge status', async () => {
    const result = await insights.staleBranches(repo.path, {
      days: 14,
      limit: 50,
      includeRemote: false,
    });
    expect(result.totalBranches).toBe(3);
    expect(result.branches).toEqual([
      expect.objectContaining({
        name: 'feature/old-experiment',
        daysSinceLastCommit: 35,
        mergedIntoHead: false,
        lastAuthor: 'Bob Example',
      }),
      expect.objectContaining({
        name: 'merged-branch',
        daysSinceLastCommit: 20,
        mergedIntoHead: true,
      }),
    ]);
  });
});

describe('commitSearch', () => {
  it('finds commits by message text, case-insensitively and literally', async () => {
    const result = await insights.commitSearch(repo.path, { query: 'FEAT', limit: 20 });
    expect(result.commits.map((c) => c.subject)).toEqual([
      'feat!: drop legacy config',
      'feat(api): add users endpoint',
    ]);
    expect(result.totalMatches).toBe(2);
    expect(result.windowDays).toBeNull();

    const regexLike = await insights.commitSearch(repo.path, { query: 'fe.t', limit: 20 });
    expect(regexLike.commits).toEqual([]);
  });

  it('also searches the commit body', async () => {
    const result = await insights.commitSearch(repo.path, { query: 'BREAKING CHANGE', limit: 20 });
    expect(result.commits.map((c) => c.subject)).toEqual(['refactor(parser): simplify']);
  });

  it('combines with window, author and path filters', async () => {
    const windowed = await insights.commitSearch(repo.path, { query: 'feat', days: 7, limit: 20 });
    expect(windowed.commits.map((c) => c.subject)).toEqual(['feat!: drop legacy config']);

    const byBob = await insights.commitSearch(repo.path, {
      query: 'fix',
      author: 'Bob',
      limit: 20,
    });
    expect(byBob.commits.map((c) => c.subject)).toEqual(['fix: handle empty input']);

    const byPath = await insights.commitSearch(repo.path, {
      query: 'docs',
      path: 'src/app.ts',
      limit: 20,
    });
    expect(byPath.commits).toEqual([]);
  });

  it('reports truncation when the limit is hit', async () => {
    const result = await insights.commitSearch(repo.path, { query: 'feat', limit: 1 });
    expect(result.commits).toHaveLength(1);
    expect(result.totalMatches).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it('rejects empty queries and unsafe paths', async () => {
    await expect(insights.commitSearch(repo.path, { query: '  ', limit: 5 })).rejects.toThrow();
    await expect(
      insights.commitSearch(repo.path, { query: 'x', limit: 5, path: '../etc' }),
    ).rejects.toThrow();
  });
});

describe('fileHistory', () => {
  let renameRepo: TempRepo;

  beforeAll(async () => {
    renameRepo = await createRenameRepo();
  });

  afterAll(async () => {
    await renameRepo?.cleanup();
  });

  it('follows a file across renames, with per-commit stats', async () => {
    const result = await insights.fileHistory(renameRepo.path, {
      path: 'lib/helpers.ts',
      limit: 20,
    });
    expect(result.path).toBe('lib/helpers.ts');
    expect(result.renamed).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.commits.map((c) => [c.subject, c.path, c.additions, c.deletions])).toEqual([
      ['fix: helpers edge case', 'lib/helpers.ts', 1, 1],
      ['refactor: rename util to helpers', 'lib/helpers.ts', 0, 0],
      ['feat: extend util', 'src/util.ts', 4, 0],
      ['chore: add util', 'src/util.ts', 7, 0],
    ]);
  });

  it('reports truncation when the limit is hit', async () => {
    const result = await insights.fileHistory(renameRepo.path, {
      path: 'lib/helpers.ts',
      limit: 2,
    });
    expect(result.commitCount).toBe(2);
    expect(result.truncated).toBe(true);
    expect(result.renamed).toBe(false);
  });

  it('returns an empty history for unknown files and rejects unsafe paths', async () => {
    const result = await insights.fileHistory(repo.path, { path: 'nope.ts', limit: 5 });
    expect(result.commits).toEqual([]);
    await expect(insights.fileHistory(repo.path, { path: '../etc', limit: 5 })).rejects.toThrow(
      InputError,
    );
  });
});

describe('compareRefs', () => {
  it('lists commits on each side of a diverged branch', async () => {
    const result = await insights.compareRefs(repo.path, {
      base: 'main',
      head: 'feature/old-experiment',
      limit: 20,
    });
    expect(result.status).toBe('diverged');
    expect(result.ahead).toBe(1);
    expect(result.behind).toBe(6);
    expect(result.truncated).toBe(false);
    expect(result.aheadCommits.map((c) => c.subject)).toEqual(['feat: risky experiment']);
    expect(result.behindCommits.map((c) => c.subject)).toEqual([
      'Update dependencies',
      'refactor(parser): simplify',
      'docs: update readme',
      'feat!: drop legacy config',
      'fix: handle empty input',
      'feat(api): add users endpoint',
    ]);
    expect(result.baseCommit).toMatch(/^[0-9a-f]{40,64}$/);
  });

  it('classifies ahead, behind and identical refs', async () => {
    const behind = await insights.compareRefs(repo.path, {
      base: 'main',
      head: 'merged-branch',
      limit: 20,
    });
    expect([behind.status, behind.ahead, behind.behind]).toEqual(['behind', 0, 5]);

    const ahead = await insights.compareRefs(repo.path, {
      base: 'v0.1.0',
      head: 'HEAD',
      limit: 20,
    });
    expect([ahead.status, ahead.ahead, ahead.behind]).toEqual(['ahead', 6, 0]);

    const same = await insights.compareRefs(repo.path, { base: 'main', head: 'HEAD', limit: 20 });
    expect(same.status).toBe('identical');
    expect(same.aheadCommits).toEqual([]);
  });

  it('reports truncation when the limit is hit', async () => {
    const result = await insights.compareRefs(repo.path, {
      base: 'v0.1.0',
      head: 'HEAD',
      limit: 2,
    });
    expect(result.ahead).toBe(6);
    expect(result.aheadCommits).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it('rejects unknown and unsafe refs', async () => {
    await expect(
      insights.compareRefs(repo.path, { base: 'nope', head: 'HEAD', limit: 5 }),
    ).rejects.toThrow(/Unknown ref/);
    await expect(
      insights.compareRefs(repo.path, { base: 'main..HEAD', head: 'HEAD', limit: 5 }),
    ).rejects.toThrow(InputError);
    await expect(
      insights.compareRefs(repo.path, { base: 'main', head: '--all', limit: 5 }),
    ).rejects.toThrow(InputError);
  });
});

describe('changeCoupling', () => {
  let couplingRepo: TempRepo;
  const defaults = { days: 30, limit: 10, minShared: 2, maxFilesPerCommit: 30 };
  const summarize = (
    pairs: { fileA: string; fileB: string; sharedCommits: number; degree: number }[],
  ) => pairs.map((p) => [p.fileA, p.fileB, p.sharedCommits, p.degree]);

  beforeAll(async () => {
    couplingRepo = await createCouplingRepo();
  });

  afterAll(async () => {
    await couplingRepo?.cleanup();
  });

  it('ranks file pairs by shared commits, then degree', async () => {
    const result = await insights.changeCoupling(couplingRepo.path, defaults);
    expect(result.commitsScanned).toBe(6);
    expect(result.commitsSkipped).toBe(0);
    expect(summarize(result.pairs)).toEqual([
      ['src/api.ts', 'test/api.test.ts', 4, 89],
      ['docs/api.md', 'test/api.test.ts', 2, 67],
      ['docs/api.md', 'src/api.ts', 2, 57],
      ['src/api.ts', 'src/db.ts', 2, 50],
    ]);
    expect(result.pairs[0]).toMatchObject({ revisionsA: 5, revisionsB: 4 });
    expect(result.pairCount).toBe(4);
  });

  it('skips large commits', async () => {
    const result = await insights.changeCoupling(couplingRepo.path, {
      ...defaults,
      maxFilesPerCommit: 3,
    });
    expect(result.commitsSkipped).toBe(1);
    expect(summarize(result.pairs)).toEqual([['src/api.ts', 'test/api.test.ts', 3, 86]]);
  });

  it('filters by file, excludes globs and honours minShared', async () => {
    const forDb = await insights.changeCoupling(couplingRepo.path, {
      ...defaults,
      file: 'src/db.ts',
      minShared: 1,
    });
    expect(summarize(forDb.pairs)).toEqual([
      ['src/api.ts', 'src/db.ts', 2, 50],
      ['docs/api.md', 'src/db.ts', 1, 40],
      ['src/db.ts', 'test/api.test.ts', 1, 29],
    ]);

    const noDocs = await insights.changeCoupling(couplingRepo.path, {
      ...defaults,
      exclude: ['docs/'],
    });
    expect(noDocs.pairs.some((p) => p.fileA.startsWith('docs/'))).toBe(false);
    expect(noDocs.pairCount).toBe(2);
  });

  it('respects the time window and rejects unsafe paths', async () => {
    const recent = await insights.changeCoupling(couplingRepo.path, { ...defaults, days: 4 });
    expect(recent.commitsScanned).toBe(3);
    await expect(
      insights.changeCoupling(couplingRepo.path, { ...defaults, file: '../etc/passwd' }),
    ).rejects.toThrow(InputError);
  });
});

describe('contributorSummary', () => {
  it('counts commits per author on HEAD', async () => {
    const result = await insights.contributorSummary(repo.path, {
      days: 30,
      limit: 20,
      includeMerges: false,
    });
    expect(result.totalCommits).toBe(6);
    expect(result.contributors.map((c) => [c.author, c.commits])).toEqual([
      ['Alice Example', 3],
      ['Bob Example', 2],
      ['Carol Example', 1],
    ]);
    const alice = result.contributors[0];
    expect(new Date(alice?.firstCommit ?? '').getTime()).toBeLessThan(
      new Date(alice?.lastCommit ?? '').getTime(),
    );
  });

  it('can be restricted to a path', async () => {
    const result = await insights.contributorSummary(repo.path, {
      days: 30,
      limit: 20,
      includeMerges: false,
      path: 'src/app.ts',
    });
    expect(result.totalCommits).toBe(3);
    expect(result.contributors.map((c) => [c.author, c.commits])).toEqual([
      ['Alice Example', 2],
      ['Bob Example', 1],
    ]);
  });

  it('rejects unsafe paths', async () => {
    await expect(
      insights.contributorSummary(repo.path, {
        days: 30,
        limit: 20,
        includeMerges: false,
        path: '../etc',
      }),
    ).rejects.toThrow();
  });
});

describe('overview', () => {
  it('summarizes the repository', async () => {
    const result = await insights.overview(repo.path);
    expect(result).toMatchObject({
      currentBranch: 'main',
      detachedHead: false,
      latestTag: 'v0.1.0',
      commitCount: 7,
      branchCount: 3,
      tagCount: 1,
    });
    expect(result.lastCommit?.subject).toBe('Update dependencies');
  });
});
