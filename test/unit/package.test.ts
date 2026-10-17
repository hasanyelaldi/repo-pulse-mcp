import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SERVER_NAME, SERVER_VERSION } from '../../src/server.js';

// The version lives in three places. The release workflow publishes all of
// them at once, so they must never drift apart.

const readJson = (file: string) =>
  JSON.parse(readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8'));

const pkg = readJson('package.json');
const server = readJson('server.json');

describe('package metadata', () => {
  it('uses one version everywhere', () => {
    expect(SERVER_VERSION).toBe(pkg.version);
    expect(server.version).toBe(pkg.version);
    for (const p of server.packages) expect(p.version).toBe(pkg.version);
  });

  it('matches the MCP Registry entry to the npm package', () => {
    expect(SERVER_NAME).toBe(pkg.name);
    expect(server.name).toBe(pkg.mcpName);
    expect(server.packages).toEqual([
      expect.objectContaining({ registryType: 'npm', identifier: pkg.name }),
    ]);
    // The registry rejects longer descriptions.
    expect(server.description.length).toBeLessThanOrEqual(100);
  });

  it('ships only the build output and docs', () => {
    expect(pkg.files).toEqual(['build', 'README.md', 'LICENSE']);
    // No leading "./": npm 11 drops such bin entries on publish, breaking npx.
    expect(pkg.bin['repo-pulse-mcp']).toBe('build/index.js');
  });
});
