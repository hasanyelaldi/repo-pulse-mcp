import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveRepositories } from '../../src/config.js';
import { RepoInsights } from '../../src/core/insights.js';
import { GitError, InputError } from '../../src/errors.js';
import { runGit } from '../../src/git/runner.js';
import { createFixtureRepo, createPlainDir, NOW, type TempRepo } from './fixture.js';

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
