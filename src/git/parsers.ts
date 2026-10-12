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

/** `git log` format: hash, author name, author date (ISO 8601 strict), subject. */
export const COMMIT_FORMAT = `${RECORD_SEP}%H${FIELD_SEP}%an${FIELD_SEP}%aI${FIELD_SEP}%s`;

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

/** Parses output produced with `--format=` {@link COMMIT_FORMAT}. */
export function parseCommits(stdout: string): Commit[] {
  return splitRecords(stdout)
    .map((record) => parseHeader(record.trim().split(FIELD_SEP)))
    .filter((commit): commit is Commit => commit !== null);
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

/** Parses output produced with `--format=` {@link COMMIT_FORMAT} `--numstat`. */
export function parseCommitsWithNumstat(stdout: string): CommitWithFiles[] {
  const commits: CommitWithFiles[] = [];
  for (const record of splitRecords(stdout)) {
    const [headerLine = '', ...statLines] = record.trim().split('\n');
    const header = parseHeader(headerLine.split(FIELD_SEP));
    if (!header) continue;

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
