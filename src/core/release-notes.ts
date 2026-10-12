import type { CommitWithBody } from '../git/parsers.js';

// Pure conventional-commit parsing and grouping. See
// https://www.conventionalcommits.org/en/v1.0.0/ for the format.

export type SectionKey =
  | 'breaking'
  | 'feat'
  | 'fix'
  | 'perf'
  | 'refactor'
  | 'docs'
  | 'test'
  | 'build'
  | 'ci'
  | 'chore'
  | 'revert'
  | 'other';

/** Section order and headings used in the generated notes. */
export const SECTIONS: ReadonlyArray<{ key: SectionKey; title: string }> = [
  { key: 'breaking', title: 'Breaking Changes' },
  { key: 'feat', title: 'Features' },
  { key: 'fix', title: 'Bug Fixes' },
  { key: 'perf', title: 'Performance' },
  { key: 'refactor', title: 'Refactoring' },
  { key: 'docs', title: 'Documentation' },
  { key: 'test', title: 'Tests' },
  { key: 'build', title: 'Build System' },
  { key: 'ci', title: 'Continuous Integration' },
  { key: 'chore', title: 'Chores' },
  { key: 'revert', title: 'Reverts' },
  { key: 'other', title: 'Other Changes' },
];

const KNOWN_TYPES = new Set<string>(SECTIONS.map((s) => s.key));

// Types that are common in the wild but fold into an existing section.
const TYPE_ALIASES: Record<string, SectionKey> = {
  style: 'chore',
  deps: 'build',
};

const HEADER_PATTERN =
  /^(?<type>[a-zA-Z]+)(?:\((?<scope>[^()\r\n]+)\))?(?<bang>!)?: (?<description>.+)$/;
const BREAKING_FOOTER_PATTERN = /^BREAKING[ -]CHANGE: /m;

export interface ParsedCommit {
  type: string | null;
  scope: string | null;
  description: string;
  breaking: boolean;
}

/** Parses a commit subject (and optional body) as a conventional commit. */
export function parseConventionalCommit(subject: string, body = ''): ParsedCommit {
  const match = HEADER_PATTERN.exec(subject.trim());
  const footerBreaking = BREAKING_FOOTER_PATTERN.test(body);
  if (!match?.groups) {
    return { type: null, scope: null, description: subject.trim(), breaking: footerBreaking };
  }
  const { type = '', scope, bang, description = '' } = match.groups;
  return {
    type: type.toLowerCase(),
    scope: scope?.trim() ?? null,
    description: description.trim(),
    breaking: bang === '!' || footerBreaking,
  };
}

export interface ReleaseNoteEntry {
  shortHash: string;
  scope: string | null;
  description: string;
  author: string;
}

export interface ReleaseNoteSection {
  key: SectionKey;
  title: string;
  entries: ReleaseNoteEntry[];
}

function sectionFor(parsed: ParsedCommit): SectionKey {
  if (parsed.type === null) return 'other';
  if (KNOWN_TYPES.has(parsed.type) && parsed.type !== 'breaking' && parsed.type !== 'other') {
    return parsed.type as SectionKey;
  }
  return TYPE_ALIASES[parsed.type] ?? 'other';
}

/**
 * Groups commits into release-note sections. Breaking changes are listed in
 * their own section *and* in their type section, so nothing is hidden.
 * Merge commits ("Merge branch ...", "Merge pull request ...") are skipped.
 * Empty sections are omitted; section order follows {@link SECTIONS}.
 */
export function groupCommits(commits: readonly CommitWithBody[]): ReleaseNoteSection[] {
  const buckets = new Map<SectionKey, ReleaseNoteEntry[]>();
  const add = (key: SectionKey, entry: ReleaseNoteEntry) => {
    const list = buckets.get(key) ?? [];
    list.push(entry);
    buckets.set(key, list);
  };

  for (const commit of commits) {
    if (/^Merge (branch|pull request|remote-tracking branch) /.test(commit.subject)) continue;
    const parsed = parseConventionalCommit(commit.subject, commit.body);
    const section = sectionFor(parsed);
    // Unknown types ("wip: ...") land in "other": keep the full subject so the type isn't lost.
    const keepSubject = section === 'other' && parsed.type !== null;
    const entry: ReleaseNoteEntry = {
      shortHash: commit.shortHash,
      scope: keepSubject ? null : parsed.scope,
      description: keepSubject ? commit.subject.trim() : parsed.description,
      author: commit.author,
    };
    if (parsed.breaking) add('breaking', entry);
    add(section, entry);
  }

  return SECTIONS.filter(({ key }) => buckets.has(key)).map(({ key, title }) => ({
    key,
    title,
    entries: buckets.get(key) ?? [],
  }));
}

/** Renders grouped sections as a Markdown draft. */
export function renderMarkdown(
  sections: readonly ReleaseNoteSection[],
  range: { from: string | null; to: string },
): string {
  const heading = range.from
    ? `## Changes from ${range.from} to ${range.to}`
    : `## Changes up to ${range.to}`;
  if (sections.length === 0) {
    return `${heading}\n\n_No changes found in this range._\n`;
  }
  const parts = [heading];
  for (const section of sections) {
    const lines = section.entries.map((entry) => {
      const scope = entry.scope ? `**${entry.scope}:** ` : '';
      return `- ${scope}${entry.description} (${entry.shortHash})`;
    });
    parts.push(`### ${section.title}\n\n${lines.join('\n')}`);
  }
  return `${parts.join('\n\n')}\n`;
}
