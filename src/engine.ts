import { sql } from 'drizzle-orm';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { toSqlParam } from './coerce.js';
import { createDrizzleMdError } from './errors.js';
import { quoteIdentifier } from './schema.js';
import type { IndexBackend } from './store.js';

/** Values that can be bound to a SQLite statement. */
export type SqlParam = string | number | bigint | null | Uint8Array;

/** Values SQLite returns for one cell. */
export type SqlValue = string | number | bigint | null | Uint8Array;

export type SqlRow = SqlValue[];

export type Driver = 'better-sqlite3' | 'node:sqlite';

/** The small slice of a synchronous SQLite driver that drizzle-md needs. */
export interface Engine {
  readonly driver: Driver;
  readonly exec: (sql: string) => void;
  readonly run: (sql: string, params: readonly SqlParam[]) => void;
  /** Runs a statement and returns rows as arrays, so joined columns with the same name survive. */
  readonly rows: (sql: string, params: readonly SqlParam[]) => SqlRow[];
  readonly close: () => void;
}

const openBetterSqlite3 = async (): Promise<Engine> => {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(':memory:');
  return {
    driver: 'better-sqlite3',
    exec: (sql) => {
      db.exec(sql);
    },
    run: (sql, params) => {
      db.prepare<SqlParam[]>(sql).run(...params);
    },
    rows: (sql, params) => {
      // The generic arguments tell better-sqlite3 what this statement returns in raw mode.
      const statement = db.prepare<SqlParam[], SqlValue[]>(sql);
      if (!statement.reader) {
        statement.run(...params);
        return [];
      }
      return statement.raw(true).all(...params);
    },
    close: () => {
      db.close();
    },
  };
};

const openNodeSqlite = async (): Promise<Engine> => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  const probe = db.prepare('SELECT 1');
  if (typeof probe.setReturnArrays !== 'function') {
    db.close();
    throw createDrizzleMdError(
      'CONFIG',
      'The node:sqlite driver needs StatementSync#setReturnArrays (Node.js 22.16 or later).',
    );
  }
  return {
    driver: 'node:sqlite',
    exec: (sql) => {
      db.exec(sql);
    },
    run: (sql, params) => {
      db.prepare(sql).run(...params);
    },
    rows: (sql, params) => {
      const statement = db.prepare(sql);
      statement.setReturnArrays(true);
      // With setReturnArrays each row is an array at runtime; Object.values keeps its order.
      return statement.all(...params).map((row) => Object.values(row));
    },
    close: () => {
      db.close();
    },
  };
};

export const openEngine = (driver: Driver): Promise<Engine> =>
  driver === 'node:sqlite' ? openNodeSqlite() : openBetterSqlite3();

/** Runs `task` with writes allowed, in one transaction. Queries run with `query_only` on. */
const writing = (engine: Engine, task: () => void) => {
  engine.exec('PRAGMA query_only = OFF');
  engine.exec('BEGIN');
  try {
    task();
    engine.exec('COMMIT');
  } catch (error) {
    engine.exec('ROLLBACK');
    throw error;
  } finally {
    engine.exec('PRAGMA query_only = ON');
  }
};

/**
 * The SQLite index behind the default entry point. Every write is synchronous inside one call, so
 * turning `query_only` off can never interleave with a user query.
 */
export const createSqliteBackend = (engine: Engine): IndexBackend<SqlParam> => {
  const dialect = new SQLiteSyncDialect();
  return {
    toParam: toSqlParam,
    evaluate: async (expression) => {
      const query = dialect.sqlToQuery(sql`select ${expression}`);
      return engine.rows(query.sql, query.params.map(toSqlParam))[0]?.[0] ?? null;
    },
    apply: async (model, changes) => {
      const table = quoteIdentifier(model.name);
      const deleteSql = `DELETE FROM ${table} WHERE ${quoteIdentifier(model.keyColumn.name)} = ?`;
      writing(engine, () => {
        for (const key of changes.deleteKeys) {
          engine.run(deleteSql, [key]);
        }
        for (const row of changes.rows) {
          engine.run(
            `INSERT INTO ${table} (${row.columns.map(quoteIdentifier).join(', ')}) VALUES (${row.columns
              .map(() => '?')
              .join(', ')})`,
            row.params,
          );
        }
      });
    },
  };
};
