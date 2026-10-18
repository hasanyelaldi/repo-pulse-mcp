// Tools grouped by the question they answer, so a client that only needs a few
// can skip the rest: every enabled tool's definition costs tokens in every
// session. The groups match the Features section of the README.
export const TOOLSETS = {
  review: ['review_context', 'file_hotspots', 'change_coupling'],
  ownership: ['knowledge_map', 'code_age', 'contributor_summary'],
  releases: ['release_notes_draft', 'list_tags', 'compare_refs', 'stale_branches'],
  history: ['recent_activity', 'commit_search', 'file_history'],
} as const satisfies Record<string, readonly string[]>;

export type ToolsetName = keyof typeof TOOLSETS;

export const ALL_TOOLS: readonly string[] = Object.values(TOOLSETS).flat();

/**
 * Turns toolset and tool names into the set of tools to register. Names can
 * be mixed ("review,list_tags"); no names or "all" means every tool. Unknown
 * names are an error, so a typo fails at startup instead of silently hiding
 * tools.
 */
export function selectTools(names: readonly string[]): ReadonlySet<string> {
  const selected = new Set<string>();
  for (const raw of names) {
    const name = raw.trim().toLowerCase();
    if (name.length === 0) continue;
    if (name === 'all') return new Set(ALL_TOOLS);
    if (Object.hasOwn(TOOLSETS, name)) {
      for (const tool of TOOLSETS[name as ToolsetName]) selected.add(tool);
    } else if (ALL_TOOLS.includes(name)) {
      selected.add(name);
    } else {
      throw new Error(
        `Unknown tool or toolset "${raw.trim()}". Toolsets: ${Object.keys(TOOLSETS).join(', ')}, all. ` +
          `Tools: ${ALL_TOOLS.join(', ')}.`,
      );
    }
  }
  return selected.size === 0 ? new Set(ALL_TOOLS) : selected;
}
