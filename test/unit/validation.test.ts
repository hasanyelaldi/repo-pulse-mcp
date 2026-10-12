import { describe, expect, it } from 'vitest';
import { InputError } from '../../src/errors.js';
import { validateAuthor, validateRef, validateRepoPath } from '../../src/git/validation.js';

describe('validateRef', () => {
  it.each([
    'HEAD',
    'main',
    'v1.2.0',
    'feature/login-form',
    'HEAD~3',
    'v1.0.0^',
    'a1b2c3d',
    'release_2026.10',
  ])('accepts %s', (ref) => {
    expect(validateRef(ref)).toBe(ref);
  });

  it.each([
    '',
    '--output=/tmp/pwned',
    '-n1',
    'main..evil',
    'HEAD@{1}',
    'main:secret.txt',
    'main branch',
    'feature/',
    'a//b',
    'refs/heads/x.lock',
    '$(rm -rf /)',
    'main;ls',
    'x'.repeat(201),
  ])('rejects %j', (ref) => {
    expect(() => validateRef(ref)).toThrow(InputError);
  });
});

describe('validateRepoPath', () => {
  it('accepts relative paths and normalizes backslashes', () => {
    expect(validateRepoPath('src/index.ts')).toBe('src/index.ts');
    expect(validateRepoPath('src\\git')).toBe('src/git');
    expect(validateRepoPath('.github/workflows')).toBe('.github/workflows');
  });

  it.each(['', '/etc/passwd', 'C:/Windows', '../outside', 'src/../../x', '--all', 'a\u0000b'])(
    'rejects %j',
    (path) => {
      expect(() => validateRepoPath(path)).toThrow(InputError);
    },
  );
});

describe('validateAuthor', () => {
  it('trims and accepts names', () => {
    expect(validateAuthor('  Alice Example ')).toBe('Alice Example');
  });

  it.each(['', '   ', 'a\nb', 'x'.repeat(101)])('rejects %j', (author) => {
    expect(() => validateAuthor(author)).toThrow(InputError);
  });
});
