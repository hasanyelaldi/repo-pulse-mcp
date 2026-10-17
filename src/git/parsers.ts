import { createHash } from 'node:crypto';

// Pure parsers for git output. Nothing in this file spawns processes, which
// keeps it trivially unit-testable with string fixtures.
//
// The format strings below use ASCII control characters as delimiters:
// unit separator (0x1f) between fields and record separator (0x1e) between
// records. They practically never occur in commit metadata, unlike tabs,
// pipes or newlines.

export const FIELD_SEP = '\x1f';
export const RECORD_SEP = '\x1e';

export interface Commit {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
  /**
   * Opaque id of the author (a hash of the email), set only for output of
   * {@link COMMIT_WITH_EMAIL_FORMAT}. Internal: never return it from a tool.
   */
  authorKey?: string;
}

export interface CommitWithBody extends Commit {
  body: string;
}

export interface FileChange {
  path: string;
  /** null for binary files, where git reports "-". */
  additions: number | null;
  deletions: number | null;
}

export interface CommitWithFiles extends Commit {
  files: FileChange[];
}

export interface BranchRef {
  name: string;
  lastCommitDate: string;
  lastAuthor: string;
}

/**
 * `git log` format: hash, author name, author date (ISO 8601 strict), subject.
 * %aN applies the repository's .mailmap, if any.
 */
export const COMMIT_FORMAT = `${RECORD_SEP}%H${FIELD_SEP}%aN${FIELD_SEP}%aI${FIELD_SEP}%s`;

/**
 * Same as {@link COMMIT_FORMAT} plus the author email, used only to recognize one
 * person committing under several names. Parsers hash it right away, so it never
 * reaches tool output.
 */
export const COMMIT_WITH_EMAIL_FORMAT = `${COMMIT_FORMAT}${FIELD_SEP}%aE`;

/** Same as {@link COMMIT_FORMAT} plus the raw body, needed for breaking-change footers. */
export const COMMIT_WITH_BODY_FORMAT = `${COMMIT_FORMAT}${FIELD_SEP}%b`;

/**
 * `git for-each-ref` format. Note that for-each-ref uses "%xx" hex escapes,
 * not the "%xXX" escapes of `git log`.
 */
export const BRANCH_FORMAT = [
  '%(refname:short)',
  '%(committerdate:iso-strict)',
  '%(authorname)',
  '%(symref)',
].join('%1f');

/**
 * `git for-each-ref refs/tags` format. Fields prefixed with "*" describe the
 * commit an annotated tag points to; they are empty for lightweight tags.
 */
export const TAG_FORMAT = [
  '%(refname:short)',
  '%(creatordate:iso-strict)',
  '%(objecttype)',
  '%(objectname)',
  '%(*objecttype)',
  '%(*objectname)',
  '%(subject)',
  '%(*subject)',
].join('%1f');

export interface TagRef {
  name: string;
  /** Tagger date for annotated tags, commit date for lightweight tags. */
  date: string;
  shortHash: string;
  /** Subject of the tagged commit. */
  subject: string;
}

function splitRecords(stdout: string): string[] {
  return stdout.split(RECORD_SEP).filter((record) => record.trim().length > 0);
}

function parseHeader(fields: string[]): Commit | null {
  const [hash, author, date, subject] = fields;
  if (!hash || !/^[0-9a-f]{40,64}$/.test(hash) || date === undefined) {
    return null;
  }
  return {
    hash,
    shortHash: hash.slice(0, 7),
    author: author ?? '',
    date,
    subject: subject ?? '',
  };
}

/** Adds {@link Commit.authorKey} when the record has an email field. */
function withAuthorKey<T extends Commit>(commit: T, email: string | undefined): T {
  const normalized = email?.trim().toLowerCase();
  if (!normalized) return commit;
  const authorKey = createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  return { ...commit, authorKey };
}

/** Parses output produced with `--format=` {@link COMMIT_FORMAT} or {@link COMMIT_WITH_EMAIL_FORMAT}. */
export function parseCommits(stdout: string): Commit[] {
  const commits: Commit[] = [];
  for (const record of splitRecords(stdout)) {
    const fields = record.trim().split(FIELD_SEP);
    const header = parseHeader(fields);
    if (header) commits.push(withAuthorKey(header, fields[4]));
  }
  return commits;
}

/** Parses output produced with `--format=` {@link COMMIT_WITH_BODY_FORMAT}. */
export function parseCommitsWithBody(stdout: string): CommitWithBody[] {
  const commits: CommitWithBody[] = [];
  for (const record of splitRecords(stdout)) {
    // Only strip leading newlines: the body is the last field and may end in whitespace.
    const fields = record.replace(/^\n+/, '').split(FIELD_SEP);
    const header = parseHeader(fields);
    if (header) {
      commits.push({ ...header, body: (fields[4] ?? '').trim() });
    }
  }
  return commits;
}

function parseCount(value: string | undefined): number | null {
  if (value === undefined || value === '-') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Parses output produced with `--format=` {@link COMMIT_FORMAT} or
 * {@link COMMIT_WITH_EMAIL_FORMAT}, plus `--numstat`.
 */
export function parseCommitsWithNumstat(stdout: string): CommitWithFiles[] {
  const commits: CommitWithFiles[] = [];
  for (const record of splitRecords(stdout)) {
    const [headerLine = '', ...statLines] = record.trim().split('\n');
    const headerFields = headerLine.split(FIELD_SEP);
    const parsed = parseHeader(headerFields);
    if (!parsed) continue;
    const header = withAuthorKey(parsed, headerFields[4]);

    const files: FileChange[] = [];
    for (const line of statLines) {
      if (line.trim().length === 0) continue;
      // numstat lines are "<additions>\t<deletions>\t<path>"; the path may contain tabs.
      const [added, deleted, ...pathParts] = line.split('\t');
      const path = pathParts.join('\t');
      if (path.length === 0) continue;
      files.push({ path, additions: parseCount(added), deletions: parseCount(deleted) });
    }
    commits.push({ ...header, files });
  }
  return commits;
}

/** Parses output produced by `git for-each-ref --format=` {@link BRANCH_FORMAT}. */
export function parseBranches(stdout: string): BranchRef[] {
  const branches: BranchRef[] = [];
  for (const line of stdout.split('\n')) {
    if (line.trim().length === 0) continue;
    const [name, lastCommitDate, lastAuthor, symref] = line.split(FIELD_SEP);
    // Skip symbolic refs such as "origin/HEAD -> origin/main".
    if (!name || !lastCommitDate || (symref ?? '').length > 0) continue;
    branches.push({ name, lastCommitDate, lastAuthor: lastAuthor ?? '' });
  }
  return branches;
}

/**
 * Parses output produced by `git for-each-ref --format=` {@link TAG_FORMAT}.
 * Tags that do not point to a commit (e.g. tagged trees) are skipped.
 */
export function parseTags(stdout: string): TagRef[] {
  const tags: TagRef[] = [];
  for (const line of stdout.split('\n')) {
    if (line.trim().length === 0) continue;
    const [name, date, type, hash, peeledType, peeledHash, subject, peeledSubject] =
      line.split(FIELD_SEP);
    const annotated = type === 'tag';
    const commitHash = annotated ? peeledHash : hash;
    if (!name || !date || (annotated ? peeledType : type) !== 'commit' || !commitHash) continue;
    tags.push({
      name,
      date,
      shortHash: commitHash.slice(0, 7),
      subject: (annotated ? peeledSubject : subject) ?? '',
    });
  }
  return tags;
}

/**
 * Resolves a numstat path that records a rename to the new path:
 * "src/{old.ts => new.ts}" becomes "src/new.ts", "old.ts => new.ts" becomes "new.ts".
 * Paths without a rename are returned unchanged.
 */
export function renamedPath(path: string): string {
  const braced = /\{([^{}]*) => ([^{}]*)\}/.exec(path);
  if (braced) {
    const resolved = path.replace(braced[0], braced[2] ?? '');
    return resolved.replaceAll('//', '/').replace(/^\//, '');
  }
  const arrow = path.indexOf(' => ');
  return arrow === -1 ? path : path.slice(arrow + ' => '.length);
}
