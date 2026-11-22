import { resolve } from 'node:path';
import { type SQL, sql } from 'drizzle-orm';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import {
  type AsyncRemoteCallback,
  drizzle,
  type SqliteRemoteDatabase,
} from 'drizzle-orm/sqlite-proxy';
import { type SqlEvaluator, toSqlParam } from './coerce.js';
import { type Driver, openEngine, type SqlRow } from './engine.js';
import {
  createDrizzleMdError,
  type Diagnostic,
  findDrizzleMdError,
  formatDiagnostic,
} from './errors.js';
import { buildModels, schemaHash, type TablesOptions } from './schema.js';
import { type ChangeEvent, createStore, type TableReport } from './store.js';
import { startWatcher, type Watcher, type WatchOptions } from './watcher.js';

export type InvalidFileMode = 'throw' | 'skip';

export interface DrizzleMdOptions<TSchema extends Record<string, object>> {
  /** Folder that holds one sub-folder per table. Relative paths resolve from the working directory. */
  readonly root: string;
  /**
   * Drizzle schema: `sqliteTable` tables and, optionally, `relations` for `db.query`. It is passed
   * to Drizzle as is.
   */
  readonly schema: TSchema;
  /** Per-table folder, key column and body column. */
  readonly tables?: TablesOptions<TSchema>;
  /**
   * What to do with files that fail validation on the first load. `throw` (default) rejects with
   * every diagnostic; `skip` leaves those files out and reports them. While watching, invalid files
   * are always skipped and reported, so a typo in one file never stops the dev server.
   */
  readonly onInvalid?: InvalidFileMode;
  /** Called for every diagnostic, on the first load and while watching. */
  readonly onDiagnostic?: (diagnostic: Diagnostic) => void;
  /** Start watching right away. Pass options to tune the watcher. */
  readonly watch?: boolean | WatchOptions;
  /** SQLite driver for the in-memory index. Defaults to `better-sqlite3`. */
  readonly driver?: Driver;
  /** File extensions that count as rows. Defaults to `['.md']`. */
  readonly extensions?: readonly string[];
}

export interface IndexReport {
  /** Hash of the table structure. It changes when the schema or table options change. */
  readonly schemaHash: string;
  readonly tables: readonly TableReport[];
  readonly diagnostics: readonly Diagnostic[];
}

export type ChangeListener = (events: readonly ChangeEvent[]) => void;

export interface DrizzleMd<TSchema extends Record<string, object>> {
  /** A read-only Drizzle database over the markdown files. */
  readonly db: SqliteRemoteDatabase<TSchema>;
  /** Current diagnostics for files that are left out of the index. */
  readonly diagnostics: () => readonly Diagnostic[];
  /** Row counts, skipped files and frontmatter keys that match no column, per table. */
  readonly report: () => IndexReport;
  /** Re-scans every folder. Unchanged files are skipped by checksum. */
  readonly reload: () => Promise<readonly ChangeEvent[]>;
  /** Starts watching the table folders. Calling it again does nothing. */
  readonly watch: (options?: WatchOptions) => void;
  /** Listens for batches of row changes from the watcher or `reload`. Returns an unsubscribe function. */
  readonly subscribe: (listener: ChangeListener) => () => void;
  /** Resolves once every queued file update has been applied. */
  readonly settled: () => Promise<void>;
  /** Stops watching and closes the in-memory database. */
  readonly close: () => Promise<void>;
}

const READ_STATEMENT =
  /^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*(?:select|with|values|explain)\b/i;

const readOnlyError = (statement: string, cause?: Error) =>
  createDrizzleMdError(
    'READ_ONLY',
    `drizzle-md is read-only in this version: edit the markdown files instead. Rejected: ${statement.trim().slice(0, 80)}`,
    cause === undefined ? {} : { cause },
  );

const isSqliteReadOnlyError = <T>(error: T): error is T & Error =>
  error instanceof Error && /readonly|read-only|query_only/i.test(error.message);

/**
 * Loads folders of markdown files into an in-memory SQLite database and returns a read-only
 * Drizzle database over them.
 *
 * @example
 * const md = await drizzleMd({ root: 'content', schema: { posts, authors } });
 * const rows = await md.db.select().from(posts).where(eq(posts.draft, false));
 */
export const drizzleMd = async <TSchema extends Record<string, object>>(
  options: DrizzleMdOptions<TSchema>,
): Promise<DrizzleMd<TSchema>> => {
  const models = buildModels(options.schema, options.tables);
  const root = resolve(options.root);
  const engine = await openEngine(options.driver ?? 'better-sqlite3');
  const dialect = new SQLiteSyncDialect();
  const userDiagnostic = options.onDiagnostic ?? (() => undefined);

  const evaluate: SqlEvaluator = (expression: SQL) => {
    const query = dialect.sqlToQuery(sql`select ${expression}`);
    return engine.rows(query.sql, query.params.map(toSqlParam))[0]?.[0] ?? null;
  };

  const store = createStore({
    engine,
    models,
    root,
    extensions: options.extensions ?? ['.md'],
    evaluate,
    onDiagnostic: (diagnostic) => userDiagnostic(diagnostic),
  });

  try {
    for (const model of models) {
      engine.exec(model.ddl);
    }
    engine.exec('PRAGMA query_only = ON');
    await store.syncAll();
  } catch (error) {
    engine.close();
    throw error;
  }

  const initial = store.diagnostics();
  if ((options.onInvalid ?? 'throw') === 'throw' && initial.length > 0) {
    engine.close();
    throw createDrizzleMdError(
      'VALIDATION',
      `${initial.length} markdown file problem(s):\n${initial.map(formatDiagnostic).join('\n')}`,
      { diagnostics: initial },
    );
  }

  let closed = false;
  let queue: Promise<void> = Promise.resolve();
  let watcher: Watcher | undefined;
  const listeners = new Set<ChangeListener>();

  const emit = (events: readonly ChangeEvent[]) => {
    if (events.length === 0) {
      return;
    }
    for (const listener of listeners) {
      listener(events);
    }
  };

  const enqueue = (task: () => Promise<ChangeEvent[]>): Promise<readonly ChangeEvent[]> => {
    const next = queue.then(async () => {
      if (closed) {
        return [];
      }
      const events = await task();
      emit(events);
      return events;
    });
    queue = next.then(
      () => undefined,
      (error) => {
        userDiagnostic({
          code: 'watch-error',
          table: '',
          file: '',
          message: error instanceof Error ? error.message : String(error),
        });
      },
    );
    return next;
  };

  const callback: AsyncRemoteCallback = async (statement, params, method) => {
    if (closed) {
      throw createDrizzleMdError('CLOSED', 'This drizzle-md instance is closed.');
    }
    if (!READ_STATEMENT.test(statement)) {
      throw readOnlyError(statement);
    }
    let rows: SqlRow[];
    try {
      rows = engine.rows(statement, params.map(toSqlParam));
    } catch (error) {
      if (isSqliteReadOnlyError(error) && findDrizzleMdError(error) === undefined) {
        throw readOnlyError(statement, error);
      }
      throw error;
    }
    if (method === 'get') {
      // Drizzle reads "no row" from an undefined `rows`, although its callback type says any[].
      // biome-ignore lint/style/noNonNullAssertion: Drizzle needs undefined here when nothing matched.
      return { rows: rows[0]! };
    }
    return { rows };
  };

  const db = drizzle(callback, { schema: options.schema });

  const watch = (watchOptions?: WatchOptions) => {
    if (watcher !== undefined || closed) {
      return;
    }
    watcher = startWatcher(
      {
        store,
        enqueue: (task) => {
          void enqueue(task);
        },
        onDiagnostic: userDiagnostic,
      },
      watchOptions,
    );
  };

  if (options.watch !== undefined && options.watch !== false) {
    watch(options.watch === true ? {} : options.watch);
  }

  return {
    db,
    diagnostics: () => store.diagnostics(),
    report: () => ({
      schemaHash: schemaHash(models),
      tables: store.report(),
      diagnostics: store.diagnostics(),
    }),
    reload: () => enqueue(() => store.syncAll()),
    watch,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    settled: () => queue,
    close: async () => {
      if (closed) {
        return;
      }
      watcher?.close();
      watcher = undefined;
      await queue;
      closed = true;
      listeners.clear();
      engine.close();
    },
  };
};
