import { InputError } from '../errors.js';

const MAX_REF_LENGTH = 200;
const MAX_PATH_LENGTH = 500;
const MAX_AUTHOR_LENGTH = 100;

// Branch/tag names, commit hashes and simple ancestry suffixes such as
// "HEAD~3" or "v1.2.0^". Deliberately narrower than what git accepts: no
// spaces, no "@{...}" reflog syntax, no ":" (path lookups), no globs.
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*(?:[~^][0-9]*)*$/;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Validates a git ref supplied by the client. Throws {@link InputError} if it
 * could be interpreted as an option, a range, or anything other than a ref.
 */
export function validateRef(ref: string): string {
  if (ref.length === 0 || ref.length > MAX_REF_LENGTH) {
    throw new InputError(`Ref must be between 1 and ${MAX_REF_LENGTH} characters.`);
  }
  if (
    !REF_PATTERN.test(ref) ||
    ref.includes('..') ||
    ref.includes('//') ||
    ref.endsWith('/') ||
    ref.endsWith('.lock')
  ) {
    throw new InputError(
      `Invalid ref "${ref}". Use a branch, tag or commit hash, optionally with ~N or ^N.`,
    );
  }
  return ref;
}

/**
 * Validates a repository-relative path filter. Absolute paths and parent
 * directory segments are rejected so a filter can never point outside the repo.
 */
export function validateRepoPath(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  if (normalized.length === 0 || normalized.length > MAX_PATH_LENGTH) {
    throw new InputError(`Path must be between 1 and ${MAX_PATH_LENGTH} characters.`);
  }
  if (CONTROL_CHARS.test(normalized)) {
    throw new InputError('Path must not contain control characters.');
  }
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new InputError('Path must be relative to the repository root.');
  }
  if (normalized.split('/').includes('..')) {
    throw new InputError('Path must not contain ".." segments.');
  }
  if (normalized.startsWith('-')) {
    throw new InputError('Path must not start with "-".');
  }
  return normalized;
}

/** Validates an author filter (matched as a fixed string, not a regex). */
export function validateAuthor(author: string): string {
  const trimmed = author.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_AUTHOR_LENGTH) {
    throw new InputError(`Author filter must be between 1 and ${MAX_AUTHOR_LENGTH} characters.`);
  }
  if (CONTROL_CHARS.test(trimmed)) {
    throw new InputError('Author filter must not contain control characters.');
  }
  return trimmed;
}
