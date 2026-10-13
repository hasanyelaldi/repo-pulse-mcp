import { InputError } from '../errors.js';

const MAX_PATTERNS = 20;
const MAX_PATTERN_LENGTH = 200;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function toRegExp(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] as string;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i += 1;
        // "**/" also matches zero directories.
        if (pattern[i + 1] === '/') {
          i += 1;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (ch === '?') {
      source += '[^/]';
    } else {
      source += ch.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

/**
 * Compiles gitignore-style exclude globs into a path predicate. Supports `*`,
 * `?` and `**`. A pattern without a slash matches at any depth, and a pattern
 * ending in `/` excludes a whole directory.
 *
 * Matching happens in-process on paths git already returned, so the
 * `--literal-pathspecs` hardening in the git runner stays untouched.
 */
export function compileExcludes(
  patterns: readonly string[] | undefined,
): (path: string) => boolean {
  if (patterns === undefined || patterns.length === 0) return () => false;
  if (patterns.length > MAX_PATTERNS) {
    throw new InputError(`At most ${MAX_PATTERNS} exclude patterns are allowed.`);
  }

  const matchers = patterns.map((raw) => {
    const pattern = raw.replaceAll('\\', '/').replace(/^\.\//, '');
    if (pattern.length === 0 || pattern.length > MAX_PATTERN_LENGTH) {
      throw new InputError(
        `Exclude pattern must be between 1 and ${MAX_PATTERN_LENGTH} characters.`,
      );
    }
    if (CONTROL_CHARS.test(pattern)) {
      throw new InputError('Exclude pattern must not contain control characters.');
    }
    const directory = pattern.endsWith('/');
    const body = directory ? pattern.slice(0, -1) : pattern;
    const anchored = body.includes('/');
    const re = toRegExp(anchored ? body.replace(/^\//, '') : `**/${body}`);
    return (path: string) => {
      if (directory) {
        // Test every leading directory prefix of the path.
        const parts = path.split('/').slice(0, -1);
        return parts.some((_, i) => re.test(parts.slice(0, i + 1).join('/')));
      }
      return re.test(path);
    };
  });

  return (path) => matchers.some((matches) => matches(path));
}
