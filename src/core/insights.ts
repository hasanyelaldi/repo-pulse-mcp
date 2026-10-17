import { InputError } from '../errors.js';
import {
  BRANCH_FORMAT,
  COMMIT_FORMAT,
  COMMIT_WITH_BODY_FORMAT,
  parseBranches,
  parseCommits,
  parseCommitsWithBody,
  parseCommitsWithNumstat,
  renamedPath,
  type Commit,
} from '../git/parsers.js';
import type { GitRunner } from '../git/runner.js';
import {
  validateAuthor,
  validateRef,
  validateRepoPath,
  validateSearchQuery,
} from '../git/validation.js';
import { compileExcludes } from './glob.js';
import { groupCommits, renderMarkdown, type ReleaseNoteSection } from './release-notes.js';

// Hard caps that apply regardless of what the client asks for. They keep a
// single call cheap even on very large repositories.
export const MAX_COMMITS_SCANNED = 5_000;
export const MAX_RELEASE_COMMITS = 500;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface InsightsDeps {
  runGit: GitRunner;
  /** Injectable clock so time-window logic is deterministic in tests. */
  now?: () => Date;
}

function sinceArg(days: number, now: Date): string {
  return `--since=${new Date(now.getTime() - days * DAY_MS).toISOString()}`;
}

function pathspec(path: string | undefined): string[] {
  return path === undefined ? [] : ['--', validateRepoPath(path)];
}

export class RepoInsights {
  private readonly runGit: GitRunner;
  private readonly now: () => Date;

  constructor(deps: InsightsDeps) {
    this.runGit = deps.runGit;
    this.now = deps.now ?? (() => new Date());
  }

  /** Resolves a user-supplied ref to a full commit hash, or throws InputError. */
  async resolveCommit(repoPath: string, ref: string): Promise<string> {
    validateRef(ref);
    try {
      const out = await this.runGit(repoPath, [
        'rev-parse',
        '--verify',
        '--quiet',
        '--end-of-options',
        `${ref}^{commit}`,
      ]);
      return out.trim();
    } catch {
      throw new InputError(`Unknown ref "${ref}" (no such branch, tag or commit).`);
    }
  }

  async recentActivity(
    repoPath: string,
    opts: { days: number; limit: number; author?: string; path?: string },
  ) {
    const filters = [sinceArg(opts.days, this.now())];
    if (opts.author !== undefined) {
      filters.push(`--author=${validateAuthor(opts.author)}`, '--fixed-strings');
    }
    const paths = pathspec(opts.path);

    const [logOut, countOut] = await Promise.all([
      this.runGit(repoPath, [
        'log',
        `--format=${COMMIT_FORMAT}`,
        `--max-count=${opts.limit}`,
        ...filters,
        'HEAD',
        ...paths,
      ]),
      this.runGit(repoPath, ['rev-list', '--count', ...filters, 'HEAD', ...paths]),
    ]);
    const commits = parseCommits(logOut);
    const totalCommits = Number.parseInt(countOut.trim(), 10) || commits.length;
    return {
      windowDays: opts.days,
      totalCommits,
      truncated: totalCommits > commits.length,
      commits,
    };
  }

  /** Case-insensitive, literal search of commit messages (subject and body) on HEAD. */
  async commitSearch(
    repoPath: string,
    opts: { query: string; days?: number; limit: number; author?: string; path?: string },
  ) {
    const filters = [
      `--grep=${validateSearchQuery(opts.query)}`,
      '--regexp-ignore-case',
      '--fixed-strings',
    ];
    if (opts.days !== undefined) filters.push(sinceArg(opts.days, this.now()));
    if (opts.author !== undefined) filters.push(`--author=${validateAuthor(opts.author)}`);
    const paths = pathspec(opts.path);

    const [logOut, countOut] = await Promise.all([
      this.runGit(repoPath, [
        'log',
        `--format=${COMMIT_FORMAT}`,
        `--max-count=${opts.limit}`,
        ...filters,
        'HEAD',
        ...paths,
      ]),
      this.runGit(repoPath, ['rev-list', '--count', ...filters, 'HEAD', ...paths]),
    ]);
    const commits = parseCommits(logOut);
    const totalMatches = Number.parseInt(countOut.trim(), 10) || commits.length;
    return {
      query: opts.query.trim(),
      windowDays: opts.days ?? null,
      totalMatches,
      truncated: totalMatches > commits.length,
      commits,
    };
  }

  /** History of a single file on HEAD, newest first, following it across renames. */
  async fileHistory(repoPath: string, opts: { path: string; limit: number }) {
    const path = validateRepoPath(opts.path);
    const out = await this.runGit(repoPath, [
      'log',
      `--format=${COMMIT_FORMAT}`,
      '--numstat',
      '--follow',
      '--no-merges',
      '--no-ext-diff',
      '--no-textconv',
      `--max-count=${opts.limit + 1}`,
      'HEAD',
      '--',
      path,
    ]);
    const all = parseCommitsWithNumstat(out);
    const commits = all.slice(0, opts.limit).map(({ files, ...commit }) => {
      const file = files[0];
      return {
        ...commit,
        path: file ? renamedPath(file.path) : null,
        additions: file?.additions ?? null,
        deletions: file?.deletions ?? null,
      };
    });
    const paths = new Set(commits.map((c) => c.path).filter((p) => p !== null));

    return {
      path,
      commitCount: commits.length,
      truncated: all.length > opts.limit,
      renamed: paths.size > 1,
      commits,
    };
  }

  async fileHotspots(
    repoPath: string,
    opts: { days: number; limit: number; path?: string; exclude?: string[] },
  ) {
    const isExcluded = compileExcludes(opts.exclude);
    const out = await this.runGit(repoPath, [
      'log',
      `--format=${COMMIT_FORMAT}`,
      '--numstat',
      '--no-renames',
      '--no-merges',
      '--no-ext-diff',
      '--no-textconv',
      `--max-count=${MAX_COMMITS_SCANNED}`,
      sinceArg(opts.days, this.now()),
      'HEAD',
      ...pathspec(opts.path),
    ]);
    const commits = parseCommitsWithNumstat(out);

    const stats = new Map<
      string,
      {
        changes: number;
        additions: number;
        deletions: number;
        authors: Set<string>;
        lastChanged: string;
      }
    >();
    // git log is newest-first, so the first time we see a file is its latest change.
    for (const commit of commits) {
      for (const file of commit.files) {
        if (isExcluded(file.path)) continue;
        const entry = stats.get(file.path) ?? {
          changes: 0,
          additions: 0,
          deletions: 0,
          authors: new Set<string>(),
          lastChanged: commit.date,
        };
        entry.changes += 1;
        entry.additions += file.additions ?? 0;
        entry.deletions += file.deletions ?? 0;
        entry.authors.add(commit.author);
        stats.set(file.path, entry);
      }
    }

    const hotspots = [...stats.entries()]
      .map(([path, s]) => ({
        path,
        changes: s.changes,
        additions: s.additions,
        deletions: s.deletions,
        authors: s.authors.size,
        lastChanged: s.lastChanged,
      }))
      .sort(
        (a, b) =>
          b.changes - a.changes ||
          b.additions + b.deletions - (a.additions + a.deletions) ||
          a.path.localeCompare(b.path),
      );

    return {
      windowDays: opts.days,
      commitsScanned: commits.length,
      scanTruncated: commits.length >= MAX_COMMITS_SCANNED,
      filesChanged: hotspots.length,
      hotspots: hotspots.slice(0, opts.limit),
    };
  }

  /** Latest tag reachable from `commit`, ignoring a tag that points at `commit` itself. */
  private async previousTag(repoPath: string, commit: string): Promise<string | null> {
    const describe = async (rev: string) => {
      try {
        const out = await this.runGit(repoPath, [
          'describe',
          '--tags',
          '--abbrev=0',
          '--end-of-options',
          rev,
        ]);
        return out.trim() || null;
      } catch {
        return null; // No tags reachable (or no parent commit).
      }
    };
    const tag = await describe(commit);
    if (tag === null) return null;
    const tagCommit = await this.resolveCommit(repoPath, tag);
    return tagCommit === commit ? describe(`${commit}^`) : tag;
  }

  async releaseNotesDraft(repoPath: string, opts: { from?: string; to: string }) {
    const toCommit = await this.resolveCommit(repoPath, opts.to);
    const from = opts.from ?? (await this.previousTag(repoPath, toCommit));
    const fromCommit = from === null ? null : await this.resolveCommit(repoPath, from);

    const out = await this.runGit(repoPath, [
      'log',
      `--format=${COMMIT_WITH_BODY_FORMAT}`,
      '--no-merges',
      `--max-count=${MAX_RELEASE_COMMITS + 1}`,
      fromCommit ? `${fromCommit}..${toCommit}` : toCommit,
    ]);
    const all = parseCommitsWithBody(out);
    const commits = all.slice(0, MAX_RELEASE_COMMITS);
    const sections: ReleaseNoteSection[] = groupCommits(commits);

    return {
      from,
      to: opts.to,
      commitCount: commits.length,
      truncated: all.length > MAX_RELEASE_COMMITS,
      sections,
      markdown: renderMarkdown(sections, { from, to: opts.to }),
    };
  }

  /** How far `head` has diverged from `base`: commit counts and lists on each side. */
  async compareRefs(repoPath: string, opts: { base: string; head: string; limit: number }) {
    const [baseCommit, headCommit] = await Promise.all([
      this.resolveCommit(repoPath, opts.base),
      this.resolveCommit(repoPath, opts.head),
    ]);
    const list = (range: string) =>
      this.runGit(repoPath, [
        'log',
        `--format=${COMMIT_FORMAT}`,
        `--max-count=${opts.limit}`,
        range,
      ]).then(parseCommits);

    const [countOut, aheadCommits, behindCommits] = await Promise.all([
      // Symmetric difference: left side is only in base, right side only in head.
      this.runGit(repoPath, [
        'rev-list',
        '--left-right',
        '--count',
        `${baseCommit}...${headCommit}`,
      ]),
      list(`${baseCommit}..${headCommit}`),
      list(`${headCommit}..${baseCommit}`),
    ]);
    const [behind = 0, ahead = 0] = countOut
      .trim()
      .split(/\s+/)
      .map((n) => Number.parseInt(n, 10) || 0);

    return {
      base: opts.base,
      head: opts.head,
      baseCommit,
      headCommit,
      ahead,
      behind,
      status:
        ahead === 0 && behind === 0
          ? ('identical' as const)
          : behind === 0
            ? ('ahead' as const)
            : ahead === 0
              ? ('behind' as const)
              : ('diverged' as const),
      truncated: ahead > aheadCommits.length || behind > behindCommits.length,
      aheadCommits,
      behindCommits,
    };
  }

  async staleBranches(
    repoPath: string,
    opts: { days: number; limit: number; includeRemote: boolean; mergedOnly?: boolean },
  ) {
    const refs = opts.includeRemote ? ['refs/heads', 'refs/remotes'] : ['refs/heads'];
    const [allOut, mergedOut] = await Promise.all([
      this.runGit(repoPath, ['for-each-ref', `--format=${BRANCH_FORMAT}`, ...refs]),
      this.runGit(repoPath, [
        'for-each-ref',
        '--merged=HEAD',
        '--format=%(refname:short)',
        ...refs,
      ]).catch(
        () => '', // Unborn HEAD: nothing is merged.
      ),
    ]);
    const merged = new Set(mergedOut.split('\n').filter(Boolean));
    const now = this.now().getTime();

    const branches = parseBranches(allOut);
    const stale = branches
      .map((b) => ({
        ...b,
        daysSinceLastCommit: Math.floor((now - new Date(b.lastCommitDate).getTime()) / DAY_MS),
        mergedIntoHead: merged.has(b.name),
      }))
      .filter((b) => b.daysSinceLastCommit >= opts.days)
      .filter((b) => !opts.mergedOnly || b.mergedIntoHead)
      .sort(
        (a, b) => b.daysSinceLastCommit - a.daysSinceLastCommit || a.name.localeCompare(b.name),
      );

    return {
      thresholdDays: opts.days,
      totalBranches: branches.length,
      staleCount: stale.length,
      branches: stale.slice(0, opts.limit),
    };
  }

  async contributorSummary(
    repoPath: string,
    opts: { days: number; limit: number; includeMerges: boolean; path?: string },
  ) {
    const out = await this.runGit(repoPath, [
      'log',
      `--format=${COMMIT_FORMAT}`,
      `--max-count=${MAX_COMMITS_SCANNED}`,
      ...(opts.includeMerges ? [] : ['--no-merges']),
      sinceArg(opts.days, this.now()),
      'HEAD',
      ...pathspec(opts.path),
    ]);
    const commits = parseCommits(out);
    const byAuthor = new Map<
      string,
      { commits: number; firstCommit: string; lastCommit: string }
    >();
    for (const c of commits) {
      const entry = byAuthor.get(c.author);
      if (entry) {
        entry.commits += 1;
        entry.firstCommit = c.date; // newest-first, so later entries are older
      } else {
        byAuthor.set(c.author, { commits: 1, firstCommit: c.date, lastCommit: c.date });
      }
    }
    const contributors = [...byAuthor.entries()]
      .map(([author, s]) => ({ author, ...s }))
      .sort((a, b) => b.commits - a.commits || a.author.localeCompare(b.author));

    return {
      windowDays: opts.days,
      totalCommits: commits.length,
      scanTruncated: commits.length >= MAX_COMMITS_SCANNED,
      contributorCount: contributors.length,
      contributors: contributors.slice(0, opts.limit),
    };
  }

  async overview(repoPath: string) {
    // Each lookup degrades gracefully: a fresh repo has no commits or tags yet.
    const optional = (args: string[]) =>
      this.runGit(repoPath, args)
        .then((s) => s.trim())
        .catch(() => null);

    const [branch, head, latestTag, commitCount, branchesOut, tagsOut] = await Promise.all([
      optional(['rev-parse', '--abbrev-ref', 'HEAD']),
      optional(['log', '-1', `--format=${COMMIT_FORMAT}`]),
      optional(['describe', '--tags', '--abbrev=0']),
      optional(['rev-list', '--count', 'HEAD']),
      optional(['for-each-ref', '--format=%(refname)', 'refs/heads']),
      optional(['for-each-ref', '--format=%(refname)', 'refs/tags']),
    ]);
    const lastCommit: Commit | null = head ? (parseCommits(head)[0] ?? null) : null;
    const count = (s: string | null) => (s ? s.split('\n').filter(Boolean).length : 0);

    return {
      currentBranch: branch === 'HEAD' ? null : branch, // "HEAD" means detached
      detachedHead: branch === 'HEAD',
      lastCommit,
      latestTag: latestTag || null,
      commitCount: commitCount ? Number.parseInt(commitCount, 10) : 0,
      branchCount: count(branchesOut),
      tagCount: count(tagsOut),
    };
  }
}
