export type DiagnosticCode =
  | 'invalid-frontmatter'
  | 'missing-required'
  | 'type-mismatch'
  | 'invalid-key'
  | 'read-error'
  | 'sql-error'
  | 'watch-error'
  | 'startup-warning';

/**
 * A problem found in one markdown file; the file is left out of the index. `watch-error` and
 * `startup-warning` are not about one file: their `table` and `file` may be empty, and they are
 * only passed to `onDiagnostic`.
 */
export interface Diagnostic {
  readonly code: DiagnosticCode;
  /** Schema key of the table, as passed in `schema`. */
  readonly table: string;
  /** File path relative to `root`, with forward slashes. */
  readonly file: string;
  /** Frontmatter key (the column's property name), when the problem is in one column. */
  readonly column?: string;
  readonly message: string;
}

export type MarkdownSqlErrorCode = 'READ_ONLY' | 'VALIDATION' | 'CONFIG' | 'CLOSED';

export interface MarkdownSqlError extends Error {
  readonly name: 'MarkdownSqlError';
  readonly code: MarkdownSqlErrorCode;
  readonly diagnostics: readonly Diagnostic[];
}

interface ErrorExtras {
  readonly diagnostics?: readonly Diagnostic[];
  readonly cause?: Error;
}

export const createMarkdownSqlError = (
  code: MarkdownSqlErrorCode,
  message: string,
  extras: ErrorExtras = {},
): MarkdownSqlError =>
  Object.assign(
    new Error(message, extras.cause === undefined ? undefined : { cause: extras.cause }),
    {
      name: 'MarkdownSqlError' as const,
      code,
      diagnostics: extras.diagnostics ?? [],
    },
  );

const ERROR_CODES: readonly string[] = ['READ_ONLY', 'VALIDATION', 'CONFIG', 'CLOSED'];

const isOwnError = <T>(error: T): error is T & MarkdownSqlError =>
  error instanceof Error &&
  error.name === 'MarkdownSqlError' &&
  'code' in error &&
  typeof error.code === 'string' &&
  ERROR_CODES.includes(error.code) &&
  'diagnostics' in error &&
  Array.isArray(error.diagnostics);

/**
 * Finds a MarkdownSQL error in `error` or its `cause` chain. Drizzle wraps errors thrown while
 * running a query in its own `DrizzleQueryError`, so check the chain rather than the top error.
 */
export const findMarkdownSqlError = <T>(error: T): MarkdownSqlError | undefined => {
  if (isOwnError(error)) {
    return error;
  }
  if (error instanceof Error && error.cause !== undefined) {
    return findMarkdownSqlError(error.cause);
  }
  return undefined;
};

export const isMarkdownSqlError = <T>(error: T, code?: MarkdownSqlErrorCode): boolean => {
  const found = findMarkdownSqlError(error);
  return found !== undefined && (code === undefined || found.code === code);
};

export const formatDiagnostic = (diagnostic: Diagnostic): string =>
  `${diagnostic.file}${diagnostic.column === undefined ? '' : ` (${diagnostic.column})`}: ${diagnostic.message}`;
