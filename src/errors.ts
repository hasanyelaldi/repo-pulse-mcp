/**
 * An error caused by invalid user (or model) input. Its message is safe to
 * show to the client and should explain how to fix the request.
 */
export class InputError extends Error {
  override readonly name = 'InputError';
}

/** A git invocation failed (non-zero exit, timeout, or output too large). */
export class GitError extends Error {
  override readonly name = 'GitError';
}
