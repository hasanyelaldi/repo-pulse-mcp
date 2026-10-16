import { describe, expect, it } from 'vitest';
import {
  FIELD_SEP as F,
  RECORD_SEP as R,
  parseBranches,
  parseCommits,
  parseCommitsWithBody,
  parseCommitsWithNumstat,
  renamedPath,
} from '../../src/git/parsers.js';

const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);

describe('parseCommits', () => {
  it('parses records separated by control characters', () => {
    const out = `${R}${HASH_A}${F}Alice Example${F}2026-01-10T10:00:00+01:00${F}feat: add x\n${R}${HASH_B}${F}Bob Example${F}2026-01-09T09:00:00Z${F}fix: subject with | pipes\tand tabs\n`;
    expect(parseCommits(out)).toEqual([
      {
        hash: HASH_A,
        shortHash: 'aaaaaaa',
        author: 'Alice Example',
        date: '2026-01-10T10:00:00+01:00',
        subject: 'feat: add x',
      },
      {
        hash: HASH_B,
        shortHash: 'bbbbbbb',
        author: 'Bob Example',
        date: '2026-01-09T09:00:00Z',
        subject: 'fix: subject with | pipes\tand tabs',
      },
    ]);
  });

  it('returns an empty list for empty output', () => {
    expect(parseCommits('')).toEqual([]);
    expect(parseCommits('\n')).toEqual([]);
  });

  it('skips malformed records', () => {
    expect(parseCommits(`${R}not-a-hash${F}x${F}y${F}z\n`)).toEqual([]);
  });
});

describe('parseCommitsWithBody', () => {
  it('keeps multi-line bodies', () => {
    const out = `${R}${HASH_A}${F}Alice${F}2026-01-10T10:00:00Z${F}feat!: drop v1${F}Long text.\n\nBREAKING CHANGE: v1 removed\n\n`;
    const [commit] = parseCommitsWithBody(out);
    expect(commit?.subject).toBe('feat!: drop v1');
    expect(commit?.body).toBe('Long text.\n\nBREAKING CHANGE: v1 removed');
  });

  it('handles an empty body', () => {
    const out = `${R}${HASH_A}${F}Alice${F}2026-01-10T10:00:00Z${F}chore: x${F}\n`;
    expect(parseCommitsWithBody(out)[0]?.body).toBe('');
  });
});

describe('parseCommitsWithNumstat', () => {
  it('attaches file stats, including binary files and paths with spaces', () => {
    const out = [
      `${R}${HASH_A}${F}Alice${F}2026-01-10T10:00:00Z${F}feat: x`,
      '',
      '10\t2\tsrc/index.ts',
      '-\t-\tassets/logo.png',
      '3\t0\tdocs/my notes.md',
      `${R}${HASH_B}${F}Bob${F}2026-01-09T10:00:00Z${F}chore: empty`,
      '',
    ].join('\n');

    const commits = parseCommitsWithNumstat(out);
    expect(commits).toHaveLength(2);
    expect(commits[0]?.files).toEqual([
      { path: 'src/index.ts', additions: 10, deletions: 2 },
      { path: 'assets/logo.png', additions: null, deletions: null },
      { path: 'docs/my notes.md', additions: 3, deletions: 0 },
    ]);
    expect(commits[1]?.files).toEqual([]);
  });
});

describe('parseBranches', () => {
  it('parses refs and skips symbolic refs', () => {
    const out = [
      `main${F}2026-01-10T10:00:00+00:00${F}Alice${F}`,
      `feature/x${F}2025-11-01T10:00:00+00:00${F}Bob${F}`,
      `origin${F}2026-01-10T10:00:00+00:00${F}Alice${F}refs/remotes/origin/main`,
      '',
    ].join('\n');
    expect(parseBranches(out)).toEqual([
      { name: 'main', lastCommitDate: '2026-01-10T10:00:00+00:00', lastAuthor: 'Alice' },
      { name: 'feature/x', lastCommitDate: '2025-11-01T10:00:00+00:00', lastAuthor: 'Bob' },
    ]);
  });
});

describe('renamedPath', () => {
  it.each([
    ['src/app.ts', 'src/app.ts'],
    ['old.ts => new.ts', 'new.ts'],
    ['src/{old.ts => new.ts}', 'src/new.ts'],
    ['{src => lib}/util.ts', 'lib/util.ts'],
    ['src/{ => nested}/util.ts', 'src/nested/util.ts'],
    ['src/{nested => }/util.ts', 'src/util.ts'],
  ])('%j -> %j', (input, expected) => {
    expect(renamedPath(input)).toBe(expected);
  });
});
