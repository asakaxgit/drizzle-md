import { PGlite, type PGliteOptions, types } from '@electric-sql/pglite';
import { live as liveExtension } from '@electric-sql/pglite/live';
import type { Query } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { drizzle, type PgRemoteDatabase, type RemoteCallback } from 'drizzle-orm/pg-proxy';
import { type BaseOptions, type DrizzleMdIndex, openIndex } from '../core.js';
import { findDrizzleMdError } from '../errors.js';
import { closedError, READ_STATEMENT, readOnlyError } from '../read-only.js';
import { buildModels, type TablesOptions } from '../schema.js';
import { createPgliteBackend } from './backend.js';
import { enumDdl, pgDialect } from './schema.js';
import { chooseSnapshot } from './snapshot.js';

/** PGlite settings drizzle-md passes through. The data directory is always in memory. */
export type PgliteOptions = Omit<PGliteOptions, 'dataDir' | 'loadDataDir'>;

export interface DrizzleMdPgOptions<TSchema extends Record<string, object>> extends BaseOptions {
  /**
   * Drizzle schema: `pgTable` tables, `pgEnum`s and, optionally, `relations` for `db.query`. It
   * is passed to Drizzle as is.
   */
  readonly schema: TSchema;
  /** Per-table folder, key column and body column. */
  readonly tables?: TablesOptions<TSchema, PgTable>;
  /**
   * Start PGlite from the `@electric-sql/pglite-prepopulatedfs` snapshot instead of running
   * initdb, which cuts startup from about 1.4 s to about 0.5 s.
   *
   * - `undefined` (default): used when the package is installed and its version is exactly the
   *   installed `@electric-sql/pglite` version. On a mismatch or a failed load PGlite starts
   *   normally and `onDiagnostic` gets a `startup-warning`.
   * - `true`: required; a missing package, a version mismatch or a failed load is a `CONFIG` error.
   * - `false`: never used.
   */
  readonly prepopulated?: boolean;
  /** Extra PGlite options, such as `extensions` (e.g. `pg_trgm`) or `debug`. */
  readonly pglite?: PgliteOptions;
  /**
   * SQL run once as the database owner after the tables are created and before any file is
   * loaded, e.g. `CREATE EXTENSION pg_trgm` or `CREATE INDEX … USING gin (tags)`. Tables it
   * creates are readable by queries too.
   *
   * **Trusted startup code.** It runs with full database rights, outside the read-only guard. Write
   * it yourself, like a migration; never build it from user input, request data, file contents
   * or anything else untrusted.
   */
  readonly setup?: string;
}

/** A query whose results `live()` keeps up to date, e.g. `md.db.select().from(posts)`. */
export interface LiveSource<TResult> extends PromiseLike<TResult> {
  readonly toSQL: () => Query;
}

export interface LiveSubscription {
  /** Stops the live query. */
  readonly unsubscribe: () => Promise<void>;
}

export interface DrizzleMdPg<TSchema extends Record<string, object>> extends DrizzleMdIndex {
  /** A read-only Drizzle database over the markdown files. */
  readonly db: PgRemoteDatabase<TSchema>;
  /**
   * Runs `query` now and again whenever a table it reads changes, e.g. after the watcher applies a
   * file. `onResult` gets Drizzle's typed rows each time. `onError` gets errors of later runs.
   */
  readonly live: <TResult>(
    query: LiveSource<TResult>,
    onResult: (result: TResult) => void,
    onError?: (error: Error) => void,
  ) => Promise<LiveSubscription>;
}

/** The role user queries run as. It can only read the index tables. */
const READER_ROLE = 'md_reader';

/** SQLSTATEs Postgres raises when a read-only transaction or the reader role blocks a write. */
const READ_ONLY_STATES: readonly string[] = ['25006', '25001', '42501'];

const isPgReadOnlyError = <T>(error: T): error is T & Error =>
  error instanceof Error &&
  'code' in error &&
  typeof error.code === 'string' &&
  READ_ONLY_STATES.includes(error.code);

/** Drizzle maps dates itself, so PGlite must hand them over as text (as drizzle-orm/pglite does). */
const RAW_DATES = {
  [types.TIMESTAMP]: (value: string) => value,
  [types.TIMESTAMPTZ]: (value: string) => value,
  [types.INTERVAL]: (value: string) => value,
  [types.DATE]: (value: string) => value,
};

const toError = <T>(error: T): Error => (error instanceof Error ? error : new Error(String(error)));

/**
 * Loads folders of markdown files into an in-memory PGlite (Postgres in WebAssembly) database and
 * returns a read-only Drizzle database over them.
 *
 * Same name and options as `drizzleMd` from `drizzle-md`: the import path picks the engine
 * (`drizzle-md` for SQLite, `drizzle-md/pg` for PGlite).
 *
 * @example
 * import { drizzleMd } from 'drizzle-md/pg';
 * const md = await drizzleMd({ root: 'content', schema: { posts, authors } });
 * const rows = await md.db.select().from(posts).where(arrayContains(posts.tags, ['drizzle']));
 */
export const drizzleMd = async <TSchema extends Record<string, object>>(
  options: DrizzleMdPgOptions<TSchema>,
): Promise<DrizzleMdPg<TSchema>> => {
  const models = buildModels(options.schema, options.tables, pgDialect);
  const enums = enumDdl(models);
  const snapshot = await chooseSnapshot(options.prepopulated);
  if (snapshot.warning !== undefined) {
    options.onDiagnostic?.({
      code: 'startup-warning',
      table: '',
      file: '',
      message: snapshot.warning,
    });
  }
  const pgliteOptions = options.pglite ?? {};
  const client = await PGlite.create({
    ...pgliteOptions,
    ...(snapshot.dataDir === undefined ? {} : { loadDataDir: snapshot.dataDir }),
    extensions: { ...pgliteOptions.extensions, live: liveExtension },
  });

  try {
    await client.exec(
      [
        ...enums,
        ...models.map((model) => model.ddl),
        ...(options.setup === undefined ? [] : [options.setup]),
        `CREATE ROLE ${READER_ROLE} NOLOGIN`,
        `GRANT USAGE ON SCHEMA public TO ${READER_ROLE}`,
        `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${READER_ROLE}`,
      ].join(';\n'),
    );
  } catch (error) {
    await client.close();
    throw error;
  }

  const subscriptions = new Set<LiveSubscription>();
  const index = await openIndex({
    options,
    models,
    backend: createPgliteBackend(client),
    closeBackend: async () => {
      for (const subscription of [...subscriptions]) {
        await subscription.unsubscribe();
      }
      await client.close();
    },
  });

  /**
   * Every statement runs in its own transaction that is READ ONLY, uses the select-only reader
   * role, and is always rolled back, so nothing a query does can outlive it.
   */
  const callback: RemoteCallback = async (statement, params, method) => {
    if (index.isClosed()) {
      throw closedError();
    }
    if (!READ_STATEMENT.test(statement)) {
      throw readOnlyError(statement);
    }
    try {
      const rows = await client.transaction(async (tx) => {
        await tx.exec(`SET TRANSACTION READ ONLY; SET LOCAL ROLE ${READER_ROLE}`);
        try {
          const result = await tx.query(statement, params, {
            rowMode: method === 'all' ? 'array' : 'object',
            parsers: RAW_DATES,
          });
          return result.rows;
        } finally {
          await tx.rollback();
        }
      });
      return { rows };
    } catch (error) {
      if (isPgReadOnlyError(error) && findDrizzleMdError(error) === undefined) {
        throw readOnlyError(statement, error);
      }
      throw error;
    }
  };

  const db = drizzle(callback, { schema: options.schema });

  const live = async <TResult>(
    query: LiveSource<TResult>,
    onResult: (result: TResult) => void,
    onError: (error: Error) => void = () => undefined,
  ): Promise<LiveSubscription> => {
    // The first run goes through the read-only path, so a query that writes is rejected before
    // PGlite's live extension (which runs as the session user) ever sees it.
    await query;
    const { sql: text, params } = query.toSQL();
    let active = true;
    let created = false;
    let runs: Promise<void> = Promise.resolve();
    const rerun = () => {
      runs = runs.then(async () => {
        if (!active) {
          return;
        }
        try {
          const result = await query;
          if (active) {
            onResult(result);
          }
        } catch (error) {
          onError(toError(error));
        }
      });
    };
    // PGlite calls back once with its initial results while creating the live query; skip that
    // call and run the query once more afterwards, so no change in between is missed.
    const handle = await client.live.query(text, params, () => {
      if (created) {
        rerun();
      }
    });
    created = true;
    const subscription: LiveSubscription = {
      unsubscribe: async () => {
        if (!active) {
          return;
        }
        active = false;
        subscriptions.delete(subscription);
        await handle.unsubscribe();
        await runs;
      },
    };
    rerun();
    await runs;
    subscriptions.add(subscription);
    return subscription;
  };

  const { isClosed: _, ...rest } = index;
  return { db, live, ...rest };
};
