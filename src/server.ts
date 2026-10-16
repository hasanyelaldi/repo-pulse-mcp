import { McpServer, ResourceTemplate, type CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { RepoRegistry } from './config.js';
import { RepoInsights } from './core/insights.js';
import { SECTIONS } from './core/release-notes.js';
import type { GitRunner } from './git/runner.js';

export const SERVER_NAME = 'repo-pulse-mcp';
export const SERVER_VERSION = '0.1.0';

export interface ServerDeps {
  registry: RepoRegistry;
  runGit: GitRunner;
  now?: () => Date;
}

// Every tool only reads local git data: tell clients it is safe to auto-approve.
const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

// ---------- Shared input fields ----------

const repoField = z
  .string()
  .max(1000)
  .optional()
  .describe(
    'Repository name or absolute path from the allowlist. Defaults to the first configured repo.',
  );

const daysField = (defaultDays: number) =>
  z
    .number()
    .int()
    .min(1)
    .max(3650)
    .default(defaultDays)
    .describe('Size of the time window in days.');

const limitField = (defaultLimit: number, max: number) =>
  z
    .number()
    .int()
    .min(1)
    .max(max)
    .default(defaultLimit)
    .describe(`Maximum number of results (1-${max}).`);

// ---------- Output schemas ----------

const commitSchema = z.object({
  hash: z.string(),
  shortHash: z.string(),
  author: z.string(),
  date: z.string().describe('Author date, ISO 8601.'),
  subject: z.string(),
});

const repoOutputField = z.string().describe('Name of the repository that was queried.');

const recentActivityOutput = z.object({
  repo: repoOutputField,
  windowDays: z.number(),
  totalCommits: z
    .number()
    .describe('All matching commits in the window, before applying the limit.'),
  truncated: z.boolean(),
  commits: z.array(commitSchema),
});

const commitSearchOutput = z.object({
  repo: repoOutputField,
  query: z.string(),
  windowDays: z.number().nullable().describe('Null when the whole history was searched.'),
  totalMatches: z.number().describe('All matching commits, before applying the limit.'),
  truncated: z.boolean(),
  commits: z.array(commitSchema),
});

const fileHistoryOutput = z.object({
  repo: repoOutputField,
  path: z.string().describe('The requested path, as it is named at HEAD.'),
  commitCount: z.number(),
  truncated: z.boolean(),
  renamed: z.boolean().describe('True if the file had a different path in a listed commit.'),
  commits: z.array(
    commitSchema.extend({
      path: z.string().nullable().describe('Path of the file in this commit.'),
      additions: z.number().nullable().describe('Null for binary files.'),
      deletions: z.number().nullable(),
    }),
  ),
});

const fileHotspotsOutput = z.object({
  repo: repoOutputField,
  windowDays: z.number(),
  commitsScanned: z.number(),
  scanTruncated: z.boolean(),
  filesChanged: z.number(),
  hotspots: z.array(
    z.object({
      path: z.string(),
      changes: z.number().describe('Number of commits that touched the file.'),
      additions: z.number(),
      deletions: z.number(),
      authors: z.number().describe('Distinct authors who touched the file.'),
      lastChanged: z.string(),
    }),
  ),
});

const releaseNotesOutput = z.object({
  repo: repoOutputField,
  from: z.string().nullable().describe('Start ref (exclusive); null means from the first commit.'),
  to: z.string(),
  commitCount: z.number(),
  truncated: z.boolean(),
  sections: z.array(
    z.object({
      key: z.enum(SECTIONS.map((s) => s.key) as [string, ...string[]]),
      title: z.string(),
      entries: z.array(
        z.object({
          shortHash: z.string(),
          scope: z.string().nullable(),
          description: z.string(),
          author: z.string(),
        }),
      ),
    }),
  ),
  markdown: z.string(),
});

const staleBranchesOutput = z.object({
  repo: repoOutputField,
  thresholdDays: z.number(),
  totalBranches: z.number(),
  staleCount: z.number(),
  branches: z.array(
    z.object({
      name: z.string(),
      lastCommitDate: z.string(),
      lastAuthor: z.string(),
      daysSinceLastCommit: z.number(),
      mergedIntoHead: z
        .boolean()
        .describe('True if the branch is fully merged into HEAD (likely safe to delete).'),
    }),
  ),
});

const contributorSummaryOutput = z.object({
  repo: repoOutputField,
  windowDays: z.number(),
  totalCommits: z.number(),
  scanTruncated: z.boolean(),
  contributorCount: z.number(),
  contributors: z.array(
    z.object({
      author: z.string(),
      commits: z.number(),
      firstCommit: z.string(),
      lastCommit: z.string(),
    }),
  ),
});

/** Returns the result both as structured content and as JSON text for older clients. */
function toolResult<T extends Record<string, unknown>>(data: T): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

/**
 * Builds the MCP server. Kept separate from the stdio entry point so tests
 * can connect it to an in-memory transport.
 */
export function createServer({ registry, runGit, now }: ServerDeps): McpServer {
  const insights = new RepoInsights({ runGit, now });
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'Read-only insight into local git repositories. Use the repo-overview resource to see ' +
        'which repositories are available, then call tools with the "repo" argument.',
    },
  );

  server.registerTool(
    'recent_activity',
    {
      title: 'Recent activity',
      description:
        'List commits on HEAD from the last N days, newest first. Optionally filter by author ' +
        '(case-sensitive substring of the author name) and/or a repository-relative path.',
      inputSchema: z.object({
        repo: repoField,
        days: daysField(7),
        author: z
          .string()
          .max(100)
          .optional()
          .describe('Only commits whose author name contains this text.'),
        path: z
          .string()
          .max(500)
          .optional()
          .describe('Only commits touching this file or directory.'),
        limit: limitField(50, 200),
      }),
      outputSchema: recentActivityOutput,
      annotations: READ_ONLY,
    },
    async ({ repo, ...opts }) => {
      const r = await registry.resolve(repo);
      return toolResult({ repo: r.name, ...(await insights.recentActivity(r.path, opts)) });
    },
  );

  server.registerTool(
    'commit_search',
    {
      title: 'Commit search',
      description:
        'Search commit messages (subject and body) on HEAD for a literal, case-insensitive text, ' +
        'newest first. Useful for finding when and why something changed, e.g. a ticket id, ' +
        'a feature name or "revert". Optionally limited to a time window, author and/or path.',
      inputSchema: z.object({
        repo: repoField,
        query: z.string().min(1).max(200).describe('Text to look for in commit messages.'),
        days: z
          .number()
          .int()
          .min(1)
          .max(3650)
          .optional()
          .describe('Only search the last N days. Omit to search the whole history.'),
        author: z
          .string()
          .max(100)
          .optional()
          .describe('Only commits whose author name contains this text.'),
        path: z
          .string()
          .max(500)
          .optional()
          .describe('Only commits touching this file or directory.'),
        limit: limitField(20, 100),
      }),
      outputSchema: commitSearchOutput,
      annotations: READ_ONLY,
    },
    async ({ repo, ...opts }) => {
      const r = await registry.resolve(repo);
      return toolResult({ repo: r.name, ...(await insights.commitSearch(r.path, opts)) });
    },
  );

  server.registerTool(
    'file_history',
    {
      title: 'File history',
      description:
        'List the commits on HEAD that changed a single file, newest first, following the file ' +
        'across renames. Each commit includes the path it had then and lines added/removed. ' +
        'Useful for "how did this file evolve?" and "who reworked it, and when?".',
      inputSchema: z.object({
        repo: repoField,
        path: z
          .string()
          .min(1)
          .max(500)
          .describe('Repository-relative path of a single file, as named at HEAD.'),
        limit: limitField(20, 100),
      }),
      outputSchema: fileHistoryOutput,
      annotations: READ_ONLY,
    },
    async ({ repo, ...opts }) => {
      const r = await registry.resolve(repo);
      return toolResult({ repo: r.name, ...(await insights.fileHistory(r.path, opts)) });
    },
  );

  server.registerTool(
    'file_hotspots',
    {
      title: 'File hotspots',
      description:
        'Rank files by how many commits changed them in the last N days (merge commits excluded). ' +
        'Useful for spotting churn, risky areas and refactoring candidates.',
      inputSchema: z.object({
        repo: repoField,
        days: daysField(90),
        path: z.string().max(500).optional().describe('Restrict to this file or directory.'),
        exclude: z
          .array(z.string().min(1).max(200))
          .max(20)
          .optional()
          .describe(
            'Glob patterns for files to leave out, e.g. ["*.lock", "dist/", "docs/**/*.md"]. ' +
              'A pattern without "/" matches at any depth; a trailing "/" excludes a directory.',
          ),
        limit: limitField(10, 100),
      }),
      outputSchema: fileHotspotsOutput,
      annotations: READ_ONLY,
    },
    async ({ repo, ...opts }) => {
      const r = await registry.resolve(repo);
      return toolResult({ repo: r.name, ...(await insights.fileHotspots(r.path, opts)) });
    },
  );

  server.registerTool(
    'release_notes_draft',
    {
      title: 'Release notes draft',
      description:
        'Group commits between two refs by conventional-commit type (breaking changes, features, ' +
        'fixes, ...) and return both structured sections and a Markdown draft. "from" defaults to ' +
        'the latest tag before "to"; without any tag, all commits up to "to" are used.',
      inputSchema: z.object({
        repo: repoField,
        from: z
          .string()
          .max(200)
          .optional()
          .describe('Start ref, exclusive (tag, branch or commit).'),
        to: z.string().max(200).default('HEAD').describe('End ref, inclusive.'),
      }),
      outputSchema: releaseNotesOutput,
      annotations: READ_ONLY,
    },
    async ({ repo, ...opts }) => {
      const r = await registry.resolve(repo);
      return toolResult({ repo: r.name, ...(await insights.releaseNotesDraft(r.path, opts)) });
    },
  );

  server.registerTool(
    'stale_branches',
    {
      title: 'Stale branches',
      description:
        'List branches whose latest commit is at least N days old, oldest first, and whether ' +
        'each is already merged into HEAD.',
      inputSchema: z.object({
        repo: repoField,
        days: daysField(30),
        includeRemote: z
          .boolean()
          .default(false)
          .describe('Also include remote-tracking branches.'),
        mergedOnly: z
          .boolean()
          .default(false)
          .describe('Only list branches already merged into HEAD, i.e. safe cleanup candidates.'),
        limit: limitField(50, 200),
      }),
      outputSchema: staleBranchesOutput,
      annotations: READ_ONLY,
    },
    async ({ repo, ...opts }) => {
      const r = await registry.resolve(repo);
      return toolResult({ repo: r.name, ...(await insights.staleBranches(r.path, opts)) });
    },
  );

  server.registerTool(
    'contributor_summary',
    {
      title: 'Contributor summary',
      description:
        'Count commits per author on HEAD in the last N days, most active first. Optionally restricted to a path.',
      inputSchema: z.object({
        repo: repoField,
        days: daysField(30),
        includeMerges: z.boolean().default(false).describe('Count merge commits too.'),
        path: z.string().max(500).optional().describe('Restrict to this file or directory.'),
        limit: limitField(20, 100),
      }),
      outputSchema: contributorSummaryOutput,
      annotations: READ_ONLY,
    },
    async ({ repo, ...opts }) => {
      const r = await registry.resolve(repo);
      return toolResult({ repo: r.name, ...(await insights.contributorSummary(r.path, opts)) });
    },
  );

  server.registerResource(
    'repo-overview',
    new ResourceTemplate('repo://{name}/overview', {
      list: async () => ({
        resources: registry.list().map((r) => ({
          uri: `repo://${encodeURIComponent(r.name)}/overview`,
          name: `${r.name} overview`,
          mimeType: 'application/json',
        })),
      }),
      complete: {
        name: (value) =>
          registry
            .list()
            .map((r) => r.name)
            .filter((n) => n.startsWith(value)),
      },
    }),
    {
      title: 'Repository overview',
      description: 'Current branch, last commit, latest tag and commit/branch/tag counts.',
      mimeType: 'application/json',
    },
    async (uri, { name }) => {
      const repoName = decodeURIComponent(String(name));
      const r = await registry.resolve(repoName);
      const data = { name: r.name, path: r.path, ...(await insights.overview(r.path)) };
      return {
        contents: [
          { uri: uri.href, mimeType: 'application/json', text: JSON.stringify(data, null, 2) },
        ],
      };
    },
  );

  server.registerPrompt(
    'weekly_engineering_update',
    {
      title: 'Weekly engineering update',
      description:
        'Draft a weekly engineering update for stakeholders from recent repository activity.',
      // Prompt arguments are always strings in MCP.
      argsSchema: z.object({
        repo: z
          .string()
          .optional()
          .describe('Repository name; defaults to the first configured repo.'),
        days: z
          .string()
          .regex(/^\d{1,3}$/)
          .optional()
          .describe('Window in days (default 7).'),
      }),
    },
    ({ repo, days }) => {
      const window = days ?? '7';
      const repoArg = repo ? `, repo: "${repo}"` : '';
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: [
                `Prepare a weekly engineering update covering the last ${window} days${repo ? ` of the "${repo}" repository` : ''}.`,
                '',
                'Gather data with the repo-pulse tools first:',
                `1. recent_activity (days: ${window}${repoArg}) for what was shipped.`,
                `2. contributor_summary (days: ${window}${repoArg}) for who contributed.`,
                `3. file_hotspots (days: ${window}${repoArg}) for where most change happened.`,
                `4. stale_branches (days: 30${repoArg}) for cleanup candidates.`,
                '',
                'Then write the update in Markdown with these sections:',
                '- **Highlights**: 3-5 bullets on the most meaningful changes, in plain language.',
                '- **Fixes & maintenance**: notable bug fixes, refactors, dependency work.',
                '- **Where the work happened**: hotspots and what they suggest (risk, focus areas).',
                '- **Housekeeping**: stale branches worth reviewing, especially ones already merged.',
                '- **Numbers**: commit count and number of contributors.',
                '',
                'Keep it under 300 words, avoid commit hashes unless they add value, and do not invent ' +
                  'anything that is not supported by the tool results.',
              ].join('\n'),
            },
          },
        ],
      };
    },
  );

  return server;
}
