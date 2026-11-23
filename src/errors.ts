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

export type SqlmdErrorCode = 'READ_ONLY' | 'VALIDATION' | 'CONFIG' | 'CLOSED';

export interface SqlmdError extends Error {
  readonly name: 'SqlmdError';
  readonly code: SqlmdErrorCode;
  readonly diagnostics: readonly Diagnostic[];
}

interface ErrorExtras {
  readonly diagnostics?: readonly Diagnostic[];
  readonly cause?: Error;
}

export const createSqlmdError = (
  code: SqlmdErrorCode,
  message: string,
  extras: ErrorExtras = {},
): SqlmdError =>
  Object.assign(
    new Error(message, extras.cause === undefined ? undefined : { cause: extras.cause }),
    {
      name: 'SqlmdError' as const,
      code,
      diagnostics: extras.diagnostics ?? [],
    },
  );

const ERROR_CODES: readonly string[] = ['READ_ONLY', 'VALIDATION', 'CONFIG', 'CLOSED'];

const isOwnError = <T>(error: T): error is T & SqlmdError =>
  error instanceof Error &&
  error.name === 'SqlmdError' &&
  'code' in error &&
  typeof error.code === 'string' &&
  ERROR_CODES.includes(error.code) &&
  'diagnostics' in error &&
  Array.isArray(error.diagnostics);

/**
 * Finds a sqlmd error in `error` or its `cause` chain. Drizzle wraps errors thrown while
 * running a query in its own `DrizzleQueryError`, so check the chain rather than the top error.
 */
export const findSqlmdError = <T>(error: T): SqlmdError | undefined => {
  if (isOwnError(error)) {
    return error;
  }
  if (error instanceof Error && error.cause !== undefined) {
    return findSqlmdError(error.cause);
  }
  return undefined;
};

export const isSqlmdError = <T>(error: T, code?: SqlmdErrorCode): boolean => {
  const found = findSqlmdError(error);
  return found !== undefined && (code === undefined || found.code === code);
};

export const formatDiagnostic = (diagnostic: Diagnostic): string =>
  `${diagnostic.file}${diagnostic.column === undefined ? '' : ` (${diagnostic.column})`}: ${diagnostic.message}`;
