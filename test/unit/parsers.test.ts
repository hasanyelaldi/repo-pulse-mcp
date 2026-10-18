import { describe, expect, it } from 'vitest';
import {
  FIELD_SEP as F,
  RECORD_SEP as R,
  parseBranches,
  parseCommits,
  parseCommitsWithBody,
  parseCommitsWithNameStatus,
  parseCommitsWithNumstat,
  parseTags,
  renamedPath,
} from '../../src/git/parsers.js';

const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);

describe('parseCommits', () => {
  it('parses records separated by control characters', () => {
    const out = `${R}${HASH_A}${F}aaaaaaa${F}Alice Example${F}2026-01-10T10:00:00+01:00${F}feat: add x\n${R}${HASH_B}${F}bbbbbbbbb${F}Bob Example${F}2026-01-09T09:00:00Z${F}fix: subject with | pipes\tand tabs\n`;
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
        shortHash: 'bbbbbbbbb', // git's %h, longer when the repository needs it
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

  it('turns the email field into an opaque author key', () => {
    const record = (email: string) =>
      `${R}${HASH_A}${F}aaaaaaa${F}Alice${F}2026-01-10T10:00:00Z${F}feat: x${F}${email}\n`;
    const [commit] = parseCommits(record('Alice@Example.com'));
    expect(commit?.authorKey).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(commit)).not.toContain('@');
    expect(parseCommits(record(' alice@example.com '))[0]?.authorKey).toBe(commit?.authorKey);
    expect(parseCommits(record('bob@example.com'))[0]?.authorKey).not.toBe(commit?.authorKey);
    expect(parseCommits(record(''))[0]).not.toHaveProperty('authorKey');
    expect(
      parseCommitsWithNumstat(`${record('alice@example.com')}1\t0\ta.ts\n`)[0]?.authorKey,
    ).toBe(commit?.authorKey);
  });

  it('skips malformed records', () => {
    expect(parseCommits(`${R}not-a-hash${F}x${F}y${F}z\n`)).toEqual([]);
  });
});

describe('parseCommitsWithBody', () => {
  it('keeps multi-line bodies', () => {
    const out = `${R}${HASH_A}${F}aaaaaaa${F}Alice${F}2026-01-10T10:00:00Z${F}feat!: drop v1${F}Long text.\n\nBREAKING CHANGE: v1 removed\n\n`;
    const [commit] = parseCommitsWithBody(out);
    expect(commit?.subject).toBe('feat!: drop v1');
    expect(commit?.body).toBe('Long text.\n\nBREAKING CHANGE: v1 removed');
  });

  it('handles an empty body', () => {
    const out = `${R}${HASH_A}${F}aaaaaaa${F}Alice${F}2026-01-10T10:00:00Z${F}chore: x${F}\n`;
    expect(parseCommitsWithBody(out)[0]?.body).toBe('');
  });
});

describe('parseCommitsWithNumstat', () => {
  it('attaches file stats, including binary files and paths with spaces', () => {
    const out = [
      `${R}${HASH_A}${F}aaaaaaa${F}Alice${F}2026-01-10T10:00:00Z${F}feat: x`,
      '',
      '10\t2\tsrc/index.ts',
      '-\t-\tassets/logo.png',
      '3\t0\tdocs/my notes.md',
      `${R}${HASH_B}${F}bbbbbbbbb${F}Bob${F}2026-01-09T10:00:00Z${F}chore: empty`,
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

describe('parseCommitsWithNameStatus', () => {
  it('attaches file statuses, including paths with spaces and tabs', () => {
    const out = [
      `${R}${HASH_A}${F}aaaaaaa${F}Alice${F}2026-01-10T10:00:00Z${F}refactor: move${F}alice@example.com`,
      '',
      'D\tsrc/old.ts',
      'A\tlib/new name.ts',
      'M\tweird\tname.md',
      `${R}${HASH_B}${F}bbbbbbbbb${F}Bob${F}2026-01-09T10:00:00Z${F}chore: empty`,
      '',
    ].join('\n');
    const [a, b] = parseCommitsWithNameStatus(out);
    expect(a?.files).toEqual([
      { status: 'D', path: 'src/old.ts' },
      { status: 'A', path: 'lib/new name.ts' },
      { status: 'M', path: 'weird\tname.md' },
    ]);
    expect(a?.authorKey).toMatch(/^[0-9a-f]{16}$/);
    expect(b?.files).toEqual([]);
  });
});

describe('parseTags', () => {
  it('uses the tagged commit for annotated tags and skips non-commit tags', () => {
    const line = (...fields: string[]) => fields.join(F);
    const out = [
      line(
        'v2.0.0',
        '2026-01-12T10:00:00Z',
        'tag',
        HASH_A,
        'commit',
        HASH_B,
        'Release 2.0',
        'feat: x',
      ),
      line('v1.0.0', '2026-01-01T09:00:00Z', 'commit', HASH_A, '', '', 'fix: y', ''),
      line('tree-tag', '2026-01-01T08:00:00Z', 'tag', HASH_A, 'tree', HASH_B, 'A tree', ''),
      '',
    ].join('\n');
    expect(parseTags(out)).toEqual([
      { name: 'v2.0.0', date: '2026-01-12T10:00:00Z', shortHash: 'bbbbbbb', subject: 'feat: x' },
      { name: 'v1.0.0', date: '2026-01-01T09:00:00Z', shortHash: 'aaaaaaa', subject: 'fix: y' },
    ]);
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
