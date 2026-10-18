import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RepoRegistry, resolveRepositories } from '../../src/config.js';
import { runGit } from '../../src/git/runner.js';
import { createServer } from '../../src/server.js';
import { ALL_TOOLS, selectTools } from '../../src/toolsets.js';
import { createFixtureRepo, NOW, type TempRepo } from './fixture.js';

// End-to-end: a real MCP client talks to the server over an in-memory transport.

let repo: TempRepo;
let client: Client;
let repoName: string;

beforeAll(async () => {
  repo = await createFixtureRepo();
  const repos = await resolveRepositories([repo.path], runGit);
  repoName = repos[0]?.name ?? '';
  const server = createServer({ registry: new RepoRegistry(repos), runGit, now: () => NOW });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterAll(async () => {
  await client?.close();
  await repo?.cleanup();
});

describe('MCP server', () => {
  it('lists thirteen read-only tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'change_coupling',
      'code_age',
      'commit_search',
      'compare_refs',
      'contributor_summary',
      'file_history',
      'file_hotspots',
      'knowledge_map',
      'list_tags',
      'recent_activity',
      'release_notes_draft',
      'review_context',
      'stale_branches',
    ]);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.outputSchema).toBeDefined();
    }
  });

  it('returns structured content that matches the text content', async () => {
    const result = await client.callTool({ name: 'recent_activity', arguments: { days: 7 } });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { repo: string; totalCommits: number };
    expect(structured.repo).toBe(repoName);
    expect(structured.totalCommits).toBe(4);
    const [first] = result.content;
    expect(first?.type).toBe('text');
    expect(JSON.parse((first as { text: string }).text)).toEqual(structured);
  });

  it('applies schema defaults', async () => {
    const result = await client.callTool({ name: 'release_notes_draft', arguments: {} });
    const structured = result.structuredContent as { from: string; markdown?: string };
    expect(structured.from).toBe('v0.1.0');
    // Markdown only by default, to keep the result small.
    expect(structured.markdown).toContain('## Features');
    expect(structured).not.toHaveProperty('sections');
  });

  it('returns compact JSON text without the full commit hash', async () => {
    const result = await client.callTool({ name: 'recent_activity', arguments: { days: 7 } });
    const text = (result.content[0] as { text: string }).text;
    expect(text).not.toContain('\n');
    const commits = (result.structuredContent as { commits: Record<string, unknown>[] }).commits;
    expect(Object.keys(commits[0] ?? {}).sort()).toEqual([
      'author',
      'date',
      'shortHash',
      'subject',
    ]);
  });

  it('reports invalid input as a tool error instead of crashing', async () => {
    const outside = await client.callTool({ name: 'recent_activity', arguments: { repo: '/etc' } });
    expect(outside.isError).toBe(true);
    expect(JSON.stringify(outside.content)).toContain('not in the allowlist');

    const badRef = await client.callTool({
      name: 'release_notes_draft',
      arguments: { to: '--all' },
    });
    expect(badRef.isError).toBe(true);

    const badDays = await client.callTool({ name: 'stale_branches', arguments: { days: -1 } });
    expect(badDays.isError).toBe(true);
  });

  it('exposes the repository overview resource', async () => {
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toEqual([
      `repo://${encodeURIComponent(repoName)}/overview`,
    ]);

    const result = await client.readResource({ uri: resources[0]?.uri ?? '' });
    const content = result.contents[0] as { text: string };
    expect(JSON.parse(content.text)).toMatchObject({
      name: repoName,
      currentBranch: 'main',
      commitCount: 7,
    });
  });

  it('assigns every registered tool to a toolset', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...ALL_TOOLS].sort());
  });

  it('registers only the selected tools, and the prompt only with its tools', async () => {
    const connect = async (names: string[]) => {
      const repos = await resolveRepositories([repo.path], runGit);
      const server = createServer({
        registry: new RepoRegistry(repos),
        runGit,
        tools: selectTools(names),
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const c = new Client({ name: 'test-client', version: '0.0.0' });
      await Promise.all([server.connect(serverTransport), c.connect(clientTransport)]);
      return c;
    };

    const review = await connect(['review', 'list_tags']);
    const { tools } = await review.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['change_coupling', 'file_hotspots', 'list_tags', 'review_context'].sort(),
    );
    expect(review.getServerCapabilities()?.prompts).toBeUndefined();
    await review.close();

    const weekly = await connect([
      'recent_activity',
      'contributor_summary',
      'file_hotspots',
      'stale_branches',
    ]);
    expect((await weekly.listPrompts()).prompts.map((p) => p.name)).toEqual([
      'weekly_engineering_update',
    ]);
    await weekly.close();
  });

  it('serves the weekly update prompt', async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(['weekly_engineering_update']);

    const result = await client.getPrompt({
      name: 'weekly_engineering_update',
      arguments: { repo: repoName, days: '14' },
    });
    const message = result.messages[0];
    expect(message?.role).toBe('user');
    const text = (message?.content as { text: string }).text;
    expect(text).toContain('last 14 days');
    expect(text).toContain('recent_activity');
  });
});
