import { InputError } from '../errors.js';
import {
  BRANCH_FORMAT,
  COMMIT_FORMAT,
  COMMIT_WITH_BODY_FORMAT,
  COMMIT_WITH_EMAIL_FORMAT,
  parseBranches,
  parseCommits,
  parseCommitsWithBody,
  parseCommitsWithNumstat,
  parseTags,
  renamedPath,
  TAG_FORMAT,
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
import {
  groupCommits,
  parseConventionalCommit,
  renderMarkdown,
  type ReleaseNoteSection,
} from './release-notes.js';

// Hard caps that apply regardless of what the client asks for. They keep a
// single call cheap even on very large repositories.
export const MAX_COMMITS_SCANNED = 5_000;
export const MAX_RELEASE_COMMITS = 500;
export const MAX_REVIEW_COMMITS = 500;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A file counts as depending on one person when that person holds at least this share. */
export const CONCENTRATED_SHARE = 80;

export interface InsightsDeps {
  runGit: GitRunner;
  /** Injectable clock so time-window logic is deterministic in tests. */
  now?: () => Date;
}

function sinceArg(days: number, now: Date): string {
  return `--since=${new Date(now.getTime() - days * DAY_MS).toISOString()}`;
}

// Fallback for commits without a conventional-commit header. Word boundaries
// keep "prefix" and "debug" from matching.
const FIX_KEYWORDS = /\b(?:fix(?:es|ed)?|bug(?:fix)?|hotfix)\b/i;

/** Conventional-commit type of a subject, or "fix" by keyword when it has none. */
function commitType(subject: string): { type: string | null; byKeyword: boolean } {
  const { type } = parseConventionalCommit(subject);
  if (type !== null) return { type, byKeyword: false };
  return FIX_KEYWORDS.test(subject)
    ? { type: 'fix', byKeyword: true }
    : { type: null, byKeyword: false };
}

function validateTypes(types: string[] | undefined): Set<string> | null {
  if (types === undefined) return null;
  const normalized = types.map((t) => t.trim().toLowerCase());
  if (normalized.length === 0 || normalized.some((t) => !/^[a-z]{1,20}$/.test(t))) {
    throw new InputError('Commit types must be 1-20 letters each, e.g. "fix" or "feat".');
  }
  return new Set(normalized);
}

/**
 * Display name per person. Commits that share an email address come from one
 * person, who is shown under the name of their newest commit, so someone who
 * committed as both "jdoe" and "Jane Doe" is counted once. Commits must be
 * newest first.
 */
function authorNames(commits: readonly Commit[]): (commit: Commit) => string {
  const names = new Map<string, string>();
  for (const c of commits) {
    if (c.authorKey !== undefined && !names.has(c.authorKey)) names.set(c.authorKey, c.author);
  }
  return (c) => (c.authorKey === undefined ? c.author : (names.get(c.authorKey) ?? c.author));
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
    opts: { days: number; limit: number; path?: string; exclude?: string[]; types?: string[] },
  ) {
    const isExcluded = compileExcludes(opts.exclude);
    const types = validateTypes(opts.types);
    const out = await this.runGit(repoPath, [
      'log',
      `--format=${COMMIT_WITH_EMAIL_FORMAT}`,
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
    const nameOf = authorNames(commits);

    const stats = new Map<
      string,
      {
        changes: number;
        fixes: number;
        additions: number;
        deletions: number;
        authors: Set<string>;
        lastChanged: string;
      }
    >();
    let commitsMatched = 0;
    let fixesFromKeywords = 0;
    // git log is newest-first, so the first time we see a file is its latest change.
    for (const commit of commits) {
      const { type, byKeyword } = commitType(commit.subject);
      if (types !== null && (type === null || !types.has(type))) continue;
      commitsMatched += 1;
      const isFix = type === 'fix';
      if (isFix && byKeyword) fixesFromKeywords += 1;
      for (const file of commit.files) {
        if (isExcluded(file.path)) continue;
        const entry = stats.get(file.path) ?? {
          changes: 0,
          fixes: 0,
          additions: 0,
          deletions: 0,
          authors: new Set<string>(),
          lastChanged: commit.date,
        };
        entry.changes += 1;
        if (isFix) entry.fixes += 1;
        entry.additions += file.additions ?? 0;
        entry.deletions += file.deletions ?? 0;
        entry.authors.add(nameOf(commit));
        stats.set(file.path, entry);
      }
    }

    const hotspots = [...stats.entries()]
      .map(([path, s]) => ({
        path,
        changes: s.changes,
        fixes: s.fixes,
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
      types: types === null ? null : [...types],
      commitsScanned: commits.length,
      scanTruncated: commits.length >= MAX_COMMITS_SCANNED,
      commitsMatched,
      fixesFromKeywords,
      filesChanged: hotspots.length,
      hotspots: hotspots.slice(0, opts.limit),
    };
  }

  /**
   * Pairs of files that tend to change in the same commits. Large commits
   * (bulk renames, formatting) are skipped because they couple everything.
   */
  async changeCoupling(
    repoPath: string,
    opts: {
      days: number;
      limit: number;
      minShared: number;
      maxFilesPerCommit: number;
      file?: string;
      path?: string;
      exclude?: string[];
    },
  ) {
    const isExcluded = compileExcludes(opts.exclude);
    const file = opts.file === undefined ? undefined : validateRepoPath(opts.file);
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

    const revisions = new Map<string, number>();
    const shared = new Map<string, number>();
    let commitsSkipped = 0;
    for (const commit of commits) {
      const files = [...new Set(commit.files.map((f) => f.path))]
        .filter((p) => !isExcluded(p))
        .sort();
      if (files.length > opts.maxFilesPerCommit) {
        commitsSkipped += 1;
        continue;
      }
      for (const [i, a] of files.entries()) {
        revisions.set(a, (revisions.get(a) ?? 0) + 1);
        for (const b of files.slice(i + 1)) {
          if (file !== undefined && a !== file && b !== file) continue;
          // NUL cannot appear in a path, so it is a safe key separator.
          const key = `${a}\0${b}`;
          shared.set(key, (shared.get(key) ?? 0) + 1);
        }
      }
    }

    const pairs = [...shared.entries()]
      .filter(([, count]) => count >= opts.minShared)
      .map(([key, sharedCommits]) => {
        const [fileA = '', fileB = ''] = key.split('\0');
        const revisionsA = revisions.get(fileA) ?? 0;
        const revisionsB = revisions.get(fileB) ?? 0;
        return {
          fileA,
          fileB,
          sharedCommits,
          revisionsA,
          revisionsB,
          // Shared commits relative to the average number of revisions, as a percentage.
          degree: Math.round((sharedCommits / ((revisionsA + revisionsB) / 2)) * 100),
        };
      })
      .sort(
        (a, b) =>
          b.sharedCommits - a.sharedCommits ||
          b.degree - a.degree ||
          a.fileA.localeCompare(b.fileA) ||
          a.fileB.localeCompare(b.fileB),
      );

    return {
      windowDays: opts.days,
      commitsScanned: commits.length,
      scanTruncated: commits.length >= MAX_COMMITS_SCANNED,
      commitsSkipped,
      pairCount: pairs.length,
      pairs: pairs.slice(0, opts.limit),
    };
  }

  /** Tags newest first, plus the latest tag on HEAD and how many commits came after it. */
  async listTags(repoPath: string, opts: { limit: number }) {
    const optional = (args: string[]) =>
      this.runGit(repoPath, args)
        .then((s) => s.trim() || null)
        .catch(() => null);

    const [tagsOut, latestOnHead] = await Promise.all([
      this.runGit(repoPath, [
        'for-each-ref',
        '--sort=-creatordate',
        `--format=${TAG_FORMAT}`,
        'refs/tags',
      ]),
      // Unborn HEAD or no reachable tag: null.
      optional(['describe', '--tags', '--abbrev=0', 'HEAD']),
    ]);
    const tags = parseTags(tagsOut);

    let commitsSinceLatest: number | null = null;
    if (latestOnHead !== null) {
      // The name comes from git itself, so it is not re-validated; it still goes
      // after --end-of-options and is resolved to a hash before use.
      const commit = await optional([
        'rev-parse',
        '--verify',
        '--quiet',
        '--end-of-options',
        `${latestOnHead}^{commit}`,
      ]);
      const count = commit && (await optional(['rev-list', '--count', `${commit}..HEAD`]));
      commitsSinceLatest = count ? Number.parseInt(count, 10) : null;
    }

    return {
      totalTags: tags.length,
      latestOnHead,
      commitsSinceLatest,
      tags: tags.slice(0, opts.limit),
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

  /**
   * Who knows a file or directory: each commit that touches a file gives its
   * author knowledge of that file, halved every halfLifeDays so recent work
   * counts more. Line counts are ignored so generated or reformatted diffs do
   * not dominate.
   */
  async knowledgeMap(
    repoPath: string,
    opts: {
      days: number;
      halfLifeDays: number;
      limit: number;
      maxFilesPerCommit: number;
      path?: string;
      exclude?: string[];
    },
  ) {
    const isExcluded = compileExcludes(opts.exclude);
    const path = opts.path === undefined ? null : validateRepoPath(opts.path);
    const now = this.now();
    const out = await this.runGit(repoPath, [
      'log',
      `--format=${COMMIT_WITH_EMAIL_FORMAT}`,
      '--numstat',
      '--no-renames',
      '--no-merges',
      '--no-ext-diff',
      '--no-textconv',
      `--max-count=${MAX_COMMITS_SCANNED}`,
      sinceArg(opts.days, now),
      'HEAD',
      ...(path === null ? [] : ['--', path]),
    ]);
    const commits = parseCommitsWithNumstat(out);
    const nameOf = authorNames(commits);

    const files = new Map<
      string,
      { weights: Map<string, number>; authors: Set<string>; commits: number; lastChanged: string }
    >();
    const authors = new Map<string, { weight: number; commits: number; lastCommit: string }>();
    let commitsSkipped = 0;
    // git log is newest-first, so the first time we see a file or author is its latest commit.
    for (const commit of commits) {
      const paths = [...new Set(commit.files.map((f) => f.path))].filter((p) => !isExcluded(p));
      if (paths.length === 0) continue;
      if (paths.length > opts.maxFilesPerCommit) {
        commitsSkipped += 1;
        continue;
      }
      const ageDays = Math.max(0, now.getTime() - new Date(commit.date).getTime()) / DAY_MS;
      const weight = 0.5 ** (ageDays / opts.halfLifeDays);

      const name = nameOf(commit);
      const author = authors.get(name) ?? {
        weight: 0,
        commits: 0,
        lastCommit: commit.date,
      };
      author.commits += 1;
      author.weight += weight * paths.length;
      authors.set(name, author);

      for (const p of paths) {
        const file = files.get(p) ?? {
          weights: new Map<string, number>(),
          authors: new Set<string>(),
          commits: 0,
          lastChanged: commit.date,
        };
        file.commits += 1;
        file.authors.add(name);
        file.weights.set(name, (file.weights.get(name) ?? 0) + weight);
        files.set(p, file);
      }
    }

    const ownedFiles = new Map<string, number>();
    const fileList = [...files.entries()].map(([filePath, f]) => {
      const [owner = '', ownerWeight = 0] =
        [...f.weights.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? [];
      const total = [...f.weights.values()].reduce((sum, w) => sum + w, 0);
      ownedFiles.set(owner, (ownedFiles.get(owner) ?? 0) + 1);
      return {
        path: filePath,
        owner,
        ownerShare: Math.round((ownerWeight / total) * 100),
        authors: f.authors.size,
        commits: f.commits,
        lastChanged: f.lastChanged,
      };
    });
    fileList.sort(
      (a, b) =>
        b.commits - a.commits || b.ownerShare - a.ownerShare || a.path.localeCompare(b.path),
    );

    const totalWeight = [...authors.values()].reduce((sum, a) => sum + a.weight, 0);
    const ranked = [...authors.entries()].sort(
      (a, b) => b[1].weight - a[1].weight || a[0].localeCompare(b[0]),
    );
    // Fewest authors who together hold more than half of the knowledge.
    let busFactor = 0;
    let covered = 0;
    for (const [, a] of ranked) {
      if (covered > totalWeight / 2) break;
      covered += a.weight;
      busFactor += 1;
    }

    return {
      path,
      windowDays: opts.days,
      halfLifeDays: opts.halfLifeDays,
      commitsScanned: commits.length,
      scanTruncated: commits.length >= MAX_COMMITS_SCANNED,
      commitsSkipped,
      filesAnalyzed: fileList.length,
      busFactor,
      concentratedFiles: fileList.filter((f) => f.ownerShare >= CONCENTRATED_SHARE).length,
      authors: ranked.slice(0, opts.limit).map(([author, a]) => ({
        author,
        share: Math.round((a.weight / totalWeight) * 100),
        filesOwned: ownedFiles.get(author) ?? 0,
        commits: a.commits,
        lastCommit: a.lastCommit,
      })),
      files: fileList.slice(0, opts.limit),
    };
  }

  /**
   * Context for reviewing the changes in base..head: how risky each changed
   * file has been on base, files that usually change with them but were left
   * out, and who knows the changed files best.
   */
  async reviewContext(
    repoPath: string,
    opts: {
      base: string;
      head: string;
      days: number;
      halfLifeDays: number;
      minShared: number;
      minDegree: number;
      maxFilesPerCommit: number;
      limit: number;
      exclude?: string[];
    },
  ) {
    const isExcluded = compileExcludes(opts.exclude);
    const [baseCommit, headCommit] = await Promise.all([
      this.resolveCommit(repoPath, opts.base),
      this.resolveCommit(repoPath, opts.head),
    ]);
    const now = this.now();
    const numstatLog = (...args: string[]) =>
      this.runGit(repoPath, [
        'log',
        `--format=${COMMIT_WITH_EMAIL_FORMAT}`,
        '--numstat',
        '--no-renames',
        '--no-merges',
        '--no-ext-diff',
        '--no-textconv',
        ...args,
      ]).then(parseCommitsWithNumstat);
    const [all, history] = await Promise.all([
      numstatLog(`--max-count=${MAX_REVIEW_COMMITS + 1}`, `${baseCommit}..${headCommit}`),
      numstatLog(`--max-count=${MAX_COMMITS_SCANNED}`, sinceArg(opts.days, now), baseCommit),
    ]);
    const changes = all.slice(0, MAX_REVIEW_COMMITS);
    // Branch commits first: they are usually the newest, so their names win.
    const nameOf = authorNames([...changes, ...history]);

    // What the branch changed.
    const changed = new Map<string, { additions: number; deletions: number }>();
    const changeAuthors = new Set<string>();
    for (const commit of changes) {
      changeAuthors.add(nameOf(commit));
      for (const file of commit.files) {
        if (isExcluded(file.path)) continue;
        const entry = changed.get(file.path) ?? { additions: 0, deletions: 0 };
        entry.additions += file.additions ?? 0;
        entry.deletions += file.deletions ?? 0;
        changed.set(file.path, entry);
      }
    }

    // How those files behaved on base.
    const stats = new Map<string, { changes: number; fixes: number; lastChanged: string }>();
    const knowledge = new Map<string, Map<string, number>>();
    const authorLastCommit = new Map<string, string>();
    const revisions = new Map<string, number>();
    const shared = new Map<string, number>();
    // git log is newest-first, so the first time we see a file or author is its latest commit.
    for (const commit of history) {
      const paths = [...new Set(commit.files.map((f) => f.path))].filter((p) => !isExcluded(p));
      const touched = paths.filter((p) => changed.has(p));
      const isFix = commitType(commit.subject).type === 'fix';
      for (const p of touched) {
        const entry = stats.get(p) ?? { changes: 0, fixes: 0, lastChanged: commit.date };
        entry.changes += 1;
        if (isFix) entry.fixes += 1;
        stats.set(p, entry);
      }
      // Bulk commits would make everyone an owner of everything and couple every file.
      if (touched.length === 0 || paths.length > opts.maxFilesPerCommit) continue;

      const ageDays = Math.max(0, now.getTime() - new Date(commit.date).getTime()) / DAY_MS;
      const weight = 0.5 ** (ageDays / opts.halfLifeDays);
      const name = nameOf(commit);
      for (const p of touched) {
        const weights = knowledge.get(name) ?? new Map<string, number>();
        weights.set(p, (weights.get(p) ?? 0) + weight);
        knowledge.set(name, weights);
      }
      if (!authorLastCommit.has(name)) authorLastCommit.set(name, commit.date);

      for (const p of paths) {
        revisions.set(p, (revisions.get(p) ?? 0) + 1);
        if (changed.has(p)) continue;
        for (const c of touched) {
          // NUL cannot appear in a path, so it is a safe key separator.
          const key = `${c}\0${p}`;
          shared.set(key, (shared.get(key) ?? 0) + 1);
        }
      }
    }

    const ownerOf = (path: string) => {
      const weights = [...knowledge.entries()]
        .map(([author, w]) => [author, w.get(path) ?? 0] as const)
        .filter(([, w]) => w > 0)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      const total = weights.reduce((sum, [, w]) => sum + w, 0);
      const [owner, ownerWeight] = weights[0] ?? [null, 0];
      return { owner, ownerShare: total > 0 ? Math.round((ownerWeight / total) * 100) : null };
    };
    const files = [...changed.entries()]
      .map(([path, c]) => {
        const s = stats.get(path);
        return {
          path,
          additions: c.additions,
          deletions: c.deletions,
          changes: s?.changes ?? 0,
          fixes: s?.fixes ?? 0,
          lastChanged: s?.lastChanged ?? null,
          ...ownerOf(path),
        };
      })
      .sort(
        (a, b) =>
          b.fixes - a.fixes ||
          b.changes - a.changes ||
          b.additions + b.deletions - (a.additions + a.deletions) ||
          a.path.localeCompare(b.path),
      );

    // Keep only the strongest link for each file that was left out.
    const companions = new Map<
      string,
      { path: string; coupledWith: string; sharedCommits: number; degree: number }
    >();
    for (const [key, sharedCommits] of shared) {
      const [coupledWith = '', path = ''] = key.split('\0');
      const avg = ((revisions.get(coupledWith) ?? 0) + (revisions.get(path) ?? 0)) / 2;
      const degree = Math.round((sharedCommits / avg) * 100);
      if (sharedCommits < opts.minShared || degree < opts.minDegree) continue;
      const best = companions.get(path);
      if (
        best === undefined ||
        degree > best.degree ||
        (degree === best.degree && sharedCommits > best.sharedCommits)
      ) {
        companions.set(path, { path, coupledWith, sharedCommits, degree });
      }
    }
    const missingCompanions = [...companions.values()].sort(
      (a, b) =>
        b.degree - a.degree || b.sharedCommits - a.sharedCommits || a.path.localeCompare(b.path),
    );

    const totalWeight = [...knowledge.values()]
      .flatMap((w) => [...w.values()])
      .reduce((sum, w) => sum + w, 0);
    const reviewers = [...knowledge.entries()]
      .filter(([author]) => !changeAuthors.has(author))
      .map(([author, w]) => ({
        author,
        weight: [...w.values()].reduce((sum, v) => sum + v, 0),
        filesKnown: w.size,
        lastCommit: authorLastCommit.get(author) ?? '',
      }))
      .sort((a, b) => b.weight - a.weight || a.author.localeCompare(b.author))
      .map(({ weight, ...r }) => ({ ...r, share: Math.round((weight / totalWeight) * 100) }));

    return {
      base: opts.base,
      head: opts.head,
      baseCommit,
      headCommit,
      windowDays: opts.days,
      commits: changes.length,
      truncated: all.length > MAX_REVIEW_COMMITS,
      changeAuthors: [...changeAuthors].sort(),
      filesChanged: files.length,
      additions: files.reduce((sum, f) => sum + f.additions, 0),
      deletions: files.reduce((sum, f) => sum + f.deletions, 0),
      historyScanned: history.length,
      scanTruncated: history.length >= MAX_COMMITS_SCANNED,
      files: files.slice(0, opts.limit),
      missingCompanions: missingCompanions.slice(0, opts.limit),
      reviewers: reviewers.slice(0, opts.limit),
    };
  }

  async contributorSummary(
    repoPath: string,
    opts: { days: number; limit: number; includeMerges: boolean; path?: string },
  ) {
    const out = await this.runGit(repoPath, [
      'log',
      `--format=${COMMIT_WITH_EMAIL_FORMAT}`,
      `--max-count=${MAX_COMMITS_SCANNED}`,
      ...(opts.includeMerges ? [] : ['--no-merges']),
      sinceArg(opts.days, this.now()),
      'HEAD',
      ...pathspec(opts.path),
    ]);
    const commits = parseCommits(out);
    const nameOf = authorNames(commits);
    const byAuthor = new Map<
      string,
      { commits: number; firstCommit: string; lastCommit: string }
    >();
    for (const c of commits) {
      const name = nameOf(c);
      const entry = byAuthor.get(name);
      if (entry) {
        entry.commits += 1;
        entry.firstCommit = c.date; // newest-first, so later entries are older
      } else {
        byAuthor.set(name, { commits: 1, firstCommit: c.date, lastCommit: c.date });
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
