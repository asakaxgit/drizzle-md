import {
  type AsyncRemoteCallback,
  drizzle,
  type SqliteRemoteDatabase,
} from 'drizzle-orm/sqlite-proxy';
import { toSqlParam } from './coerce.js';
import { type BaseOptions, type DrizzleMdIndex, openIndex } from './core.js';
import { createSqliteBackend, type Driver, openEngine, type SqlRow } from './engine.js';
import { findDrizzleMdError } from './errors.js';
import { closedError, READ_STATEMENT, readOnlyError } from './read-only.js';
import { buildModels, sqliteDialect, type TablesOptions } from './schema.js';

export type { ChangeListener, IndexReport, InvalidFileMode } from './core.js';

export interface DrizzleMdOptions<TSchema extends Record<string, object>> extends BaseOptions {
  /**
   * Drizzle schema: `sqliteTable` tables and, optionally, `relations` for `db.query`. It is passed
   * to Drizzle as is.
   */
  readonly schema: TSchema;
  /** Per-table folder, key column and body column. */
  readonly tables?: TablesOptions<TSchema>;
  /** SQLite driver for the in-memory index. Defaults to `better-sqlite3`. */
  readonly driver?: Driver;
}

export interface DrizzleMd<TSchema extends Record<string, object>> extends DrizzleMdIndex {
  /** A read-only Drizzle database over the markdown files. */
  readonly db: SqliteRemoteDatabase<TSchema>;
}

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
  const models = buildModels(options.schema, options.tables, sqliteDialect);
  const engine = await openEngine(options.driver ?? 'better-sqlite3');
  try {
    for (const model of models) {
      engine.exec(model.ddl);
    }
    engine.exec('PRAGMA query_only = ON');
  } catch (error) {
    engine.close();
    throw error;
  }

  const index = await openIndex({
    options,
    models,
    backend: createSqliteBackend(engine),
    closeBackend: async () => {
      engine.close();
    },
  });

  const callback: AsyncRemoteCallback = async (statement, params, method) => {
    if (index.isClosed()) {
      throw closedError();
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

  const { isClosed: _, ...rest } = index;
  return { db: drizzle(callback, { schema: options.schema }), ...rest };
};
