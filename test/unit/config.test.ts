import { delimiter } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseRepoPaths,
  parseToolNames,
  RepoRegistry,
  REPOS_ENV_VAR,
  TOOLS_ENV_VAR,
} from '../../src/config.js';
import { InputError } from '../../src/errors.js';

describe('parseRepoPaths', () => {
  it('reads --repo flags (both forms) and the env var', () => {
    const paths = parseRepoPaths(['--repo', '/a', '--repo=/b', '--other'], {
      [REPOS_ENV_VAR]: ['/c', '', ' /d '].join(delimiter),
    });
    expect(paths).toEqual(['/a', '/b', '/c', '/d']);
  });

  it('reads plain positional paths, in order, and ignores other flags', () => {
    expect(parseRepoPaths(['/a', '--verbose', '--repo', '/b', '/c'], {})).toEqual([
      '/a',
      '/b',
      '/c',
    ]);
  });

  it('does not mistake the --tools value for a path', () => {
    expect(parseRepoPaths(['--tools', 'review', '/a', '--tools=history'], {})).toEqual(['/a']);
  });

  it('returns nothing when unconfigured', () => {
    expect(parseRepoPaths([], {})).toEqual([]);
  });

  it('rejects --repo without a value', () => {
    expect(() => parseRepoPaths(['--repo'], {})).toThrow(/requires a path/);
  });
});

describe('parseToolNames', () => {
  it('reads comma-separated --tools flags (both forms) and the env var', () => {
    const names = parseToolNames(['/repo', '--tools', 'review, list_tags', '--tools=history'], {
      [TOOLS_ENV_VAR]: 'ownership,',
    });
    expect(names).toEqual(['review', 'list_tags', 'history', 'ownership']);
  });

  it('returns nothing when unconfigured and rejects --tools without a value', () => {
    expect(parseToolNames(['/repo'], {})).toEqual([]);
    expect(() => parseToolNames(['--tools'], {})).toThrow(/comma-separated/);
  });
});

describe('RepoRegistry', () => {
  const registry = new RepoRegistry([
    { name: 'alpha', path: '/repos/alpha' },
    { name: 'beta', path: '/repos/beta' },
  ]);

  it('defaults to the first repository', async () => {
    expect((await registry.resolve()).name).toBe('alpha');
    expect((await registry.resolve('')).name).toBe('alpha');
  });

  it('resolves by name', async () => {
    expect((await registry.resolve('beta')).path).toBe('/repos/beta');
  });

  it('rejects anything not on the allowlist', async () => {
    await expect(registry.resolve('gamma')).rejects.toThrow(InputError);
    await expect(registry.resolve('/etc')).rejects.toThrow(/not in the allowlist/);
    await expect(registry.resolve('../alpha')).rejects.toThrow(InputError);
  });

  it('requires at least one repository', () => {
    expect(() => new RepoRegistry([])).toThrow();
  });
});
