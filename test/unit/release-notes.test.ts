import { describe, expect, it } from 'vitest';
import {
  groupCommits,
  parseConventionalCommit,
  renderMarkdown,
} from '../../src/core/release-notes.js';
import type { CommitWithBody } from '../../src/git/parsers.js';

let counter = 0;
function commit(subject: string, body = '', author = 'Alice Example'): CommitWithBody {
  counter++;
  const hash = counter.toString(16).padStart(40, '0');
  return { hash, shortHash: hash.slice(0, 7), author, date: '2026-01-01T00:00:00Z', subject, body };
}

describe('parseConventionalCommit', () => {
  it('parses type, scope and description', () => {
    expect(parseConventionalCommit('feat(api): add users endpoint')).toEqual({
      type: 'feat',
      scope: 'api',
      description: 'add users endpoint',
      breaking: false,
    });
  });

  it('detects "!" and BREAKING CHANGE footers', () => {
    expect(parseConventionalCommit('feat!: drop node 18').breaking).toBe(true);
    expect(parseConventionalCommit('refactor(core)!: rename').breaking).toBe(true);
    expect(parseConventionalCommit('fix: x', 'Body\n\nBREAKING CHANGE: y').breaking).toBe(true);
    expect(parseConventionalCommit('fix: x', 'BREAKING-CHANGE: y').breaking).toBe(true);
    expect(parseConventionalCommit('fix: x', 'not a breaking change').breaking).toBe(false);
  });

  it('normalizes the type to lower case', () => {
    expect(parseConventionalCommit('Fix: typo').type).toBe('fix');
  });

  it('treats non-conventional subjects as untyped', () => {
    expect(parseConventionalCommit('Update dependencies')).toEqual({
      type: null,
      scope: null,
      description: 'Update dependencies',
      breaking: false,
    });
    // Missing space after the colon is not a conventional header.
    expect(parseConventionalCommit('feat:no space').type).toBeNull();
  });
});

describe('groupCommits', () => {
  it('groups by type in a fixed order and lists breaking changes twice', () => {
    const sections = groupCommits([
      commit('docs: update readme'),
      commit('fix: handle empty input'),
      commit('feat!: drop legacy config'),
      commit('feat(api): add users endpoint'),
      commit('style: format code'),
      commit('Update dependencies'),
      commit('wip: something'),
    ]);

    expect(sections.map((s) => s.key)).toEqual([
      'breaking',
      'feat',
      'fix',
      'docs',
      'chore',
      'other',
    ]);
    expect(sections.find((s) => s.key === 'breaking')?.entries.map((e) => e.description)).toEqual([
      'drop legacy config',
    ]);
    expect(sections.find((s) => s.key === 'feat')?.entries).toHaveLength(2);
    expect(sections.find((s) => s.key === 'chore')?.entries[0]?.description).toBe('format code');
    expect(sections.find((s) => s.key === 'other')?.entries.map((e) => e.description)).toEqual([
      'Update dependencies',
      'wip: something',
    ]);
  });

  it('skips merge commits', () => {
    const sections = groupCommits([
      commit("Merge branch 'feature/x'"),
      commit('Merge pull request #12 from someone/branch'),
      commit('fix: real change'),
    ]);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.key).toBe('fix');
  });

  it('returns no sections for no commits', () => {
    expect(groupCommits([])).toEqual([]);
  });
});

describe('renderMarkdown', () => {
  it('renders headings, scopes and short hashes', () => {
    const c = commit('feat(api): add users endpoint');
    const md = renderMarkdown(groupCommits([c]), { from: 'v0.1.0', to: 'HEAD' });
    expect(md).toBe(
      `## Changes from v0.1.0 to HEAD\n\n### Features\n\n- **api:** add users endpoint (${c.shortHash})\n`,
    );
  });

  it('handles empty ranges and missing "from"', () => {
    expect(renderMarkdown([], { from: null, to: 'main' })).toBe(
      '## Changes up to main\n\n_No changes found in this range._\n',
    );
  });
});
