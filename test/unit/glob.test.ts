import { describe, expect, it } from 'vitest';
import { InputError } from '../../src/errors.js';
import { compileExcludes } from '../../src/core/glob.js';

describe('compileExcludes', () => {
  it('matches nothing without patterns', () => {
    expect(compileExcludes(undefined)('a.ts')).toBe(false);
    expect(compileExcludes([])('a.ts')).toBe(false);
  });

  it('matches slash-less patterns at any depth', () => {
    const exclude = compileExcludes(['*.lock', 'package-lock.json']);
    expect(exclude('yarn.lock')).toBe(true);
    expect(exclude('apps/web/package-lock.json')).toBe(true);
    expect(exclude('src/lock.ts')).toBe(false);
  });

  it('anchors patterns that contain a slash', () => {
    const exclude = compileExcludes(['docs/**/*.md', 'src/*.gen.ts']);
    expect(exclude('docs/guide/intro.md')).toBe(true);
    expect(exclude('docs/intro.md')).toBe(true);
    expect(exclude('other/docs/intro.md')).toBe(false);
    expect(exclude('src/a.gen.ts')).toBe(true);
    expect(exclude('src/deep/a.gen.ts')).toBe(false);
  });

  it('excludes whole directories with a trailing slash', () => {
    const exclude = compileExcludes(['dist/', 'node_modules/']);
    expect(exclude('dist/index.js')).toBe(true);
    expect(exclude('packages/a/node_modules/x/y.js')).toBe(true);
    expect(exclude('distance.ts')).toBe(false);
  });

  it('treats regex characters literally', () => {
    const exclude = compileExcludes(['a+b(1).ts']);
    expect(exclude('a+b(1).ts')).toBe(true);
    expect(exclude('aab1.ts')).toBe(false);
  });

  it('rejects invalid pattern lists', () => {
    expect(() => compileExcludes([''])).toThrow(InputError);
    expect(() => compileExcludes(['a\nb'])).toThrow(InputError);
    expect(() => compileExcludes(Array.from({ length: 21 }, () => 'x'))).toThrow(InputError);
  });
});
