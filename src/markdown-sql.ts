import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { toSqlParam } from './coerce.js';
import {
  buildMarkdownSqlModel,
  type ColumnDefinition,
  type ColumnType,
  inferColumns,
  type MarkdownSqlTableOptions,
} from './columns.js';
import { type BaseOptions, type MarkdownSqlIndex, openIndex } from './core.js';
import {
  createSqliteBackend,
  type Driver,
  type Engine,
  openEngine,
  type SqlParam,
  type SqlValue,
} from './engine.js';
import { createMarkdownSqlError, findMarkdownSqlError } from './errors.js';
import type { ColumnRole, TableModel } from './model.js';
import { closedError, READ_STATEMENT, readOnlyError } from './read-only.js';

export interface MarkdownSqlOptions extends BaseOptions {
  /**
   * Tables by SQL name. Left out, every sub-folder of `root` (except ones starting with `.` or
   * `_`) is a table named after the folder, with columns inferred from its files.
   */
  readonly tables?: Readonly<Record<string, MarkdownSqlTableOptions>>;
  /** SQLite driver for the in-memory index. Defaults to `better-sqlite3`. */
  readonly driver?: Driver;
}

/** A value bound to a `?` placeholder. Booleans are bound as `1` and `0`. */
export type MarkdownSqlParam = SqlParam | boolean;

/** One result row, keyed by result column name. When two columns share a name, the last wins. */
export interface MarkdownSqlRow {
  readonly [column: string]: SqlValue;
}

export interface ColumnInfo {
  readonly name: string;
  readonly type: ColumnType;
  readonly role: ColumnRole;
  readonly required: boolean;
}

export interface TableInfo {
  readonly table: string;
  readonly dir: string;
  readonly columns: readonly ColumnInfo[];
}

export interface MarkdownSql extends MarkdownSqlIndex {
  /**
   * Runs one read-only SQL statement (`SELECT`, `WITH`, `VALUES` or `EXPLAIN`) with `?`
   * parameters and returns its rows.
   */
  readonly query: (
    sql: string,
    params?: readonly MarkdownSqlParam[],
  ) => Promise<readonly MarkdownSqlRow[]>;
  /**
   * Tagged-template form of `query`: every `${value}` becomes a bound parameter, never SQL text.
   *
   * @example
   * const rows = await md.sql`select title from posts where views > ${100}`;
   */
  readonly sql: (
    strings: TemplateStringsArray,
    ...values: readonly MarkdownSqlParam[]
  ) => Promise<readonly MarkdownSqlRow[]>;
  /** The tables and columns of the index, including inferred ones. */
  readonly tables: () => readonly TableInfo[];
}

const isSqliteReadOnlyError = <T>(error: T): error is T & Error =>
  error instanceof Error && /readonly|read-only|query_only/i.test(error.message);

const discoverTables = async (
  root: string,
): Promise<Readonly<Record<string, MarkdownSqlTableOptions>>> => {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    throw createMarkdownSqlError(
      'CONFIG',
      `Cannot read the root folder ${root}: ${error instanceof Error ? error.message : String(error)}`,
      error instanceof Error ? { cause: error } : {},
    );
  }
  const tables = entries
    .filter((entry) => entry.isDirectory() && !/^[._]/.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  if (tables.length === 0) {
    throw createMarkdownSqlError('CONFIG', `The root folder ${root} has no table folders.`);
  }
  return Object.fromEntries(tables.map((table) => [table, {}]));
};

const buildModels = async (options: MarkdownSqlOptions): Promise<readonly TableModel[]> => {
  const root = resolve(options.root);
  const tables = options.tables ?? (await discoverTables(root));
  const extensions = options.extensions ?? ['.md'];
  const entries = Object.entries(tables);
  if (entries.length === 0) {
    throw createMarkdownSqlError('CONFIG', 'tables is empty: declare at least one table.');
  }
  const models: TableModel[] = [];
  for (const [table, tableOptions] of entries) {
    const reserved = [tableOptions.key ?? 'id'];
    if (tableOptions.body !== false) {
      reserved.push(tableOptions.body ?? 'body');
    }
    const columns =
      tableOptions.columns ??
      (await inferColumns(join(root, tableOptions.dir ?? table), extensions, reserved));
    models.push(buildMarkdownSqlModel(table, tableOptions, columns));
  }
  return models;
};

const TYPES_BY_SQL: Readonly<Record<string, ColumnType>> = { integer: 'integer', real: 'real' };

const typeOf = (kind: string, sqlType: string): ColumnType => {
  if (kind === 'boolean' || kind === 'date' || kind === 'json') {
    return kind;
  }
  return TYPES_BY_SQL[sqlType] ?? 'text';
};

const tableInfo = (model: TableModel): TableInfo => ({
  table: model.name,
  dir: model.dir,
  columns: model.columns.map((column) => ({
    name: column.name,
    type: typeOf(column.spec.kind, column.spec.sqlType),
    role: column.role,
    required: column.spec.notNull,
  })),
});

const runQuery = (
  engine: Engine,
  statement: string,
  params: readonly MarkdownSqlParam[],
): MarkdownSqlRow[] => {
  if (!READ_STATEMENT.test(statement)) {
    throw readOnlyError(statement);
  }
  try {
    const result = engine.table(statement, params.map(toSqlParam));
    return result.rows.map(
      (row): MarkdownSqlRow =>
        Object.fromEntries(result.columns.map((column, index) => [column, row[index] ?? null])),
    );
  } catch (error) {
    if (isSqliteReadOnlyError(error) && findMarkdownSqlError(error) === undefined) {
      throw readOnlyError(statement, error);
    }
    throw error;
  }
};

/**
 * Loads folders of markdown files into an in-memory SQLite database and queries them with plain,
 * read-only SQL. No ORM needed: tables come from the folders and columns from the frontmatter,
 * inferred or declared in `tables`.
 *
 * For Drizzle, import `drizzleMd` from `markdown-sql/drizzle` (SQLite) or `markdown-sql/pg` (PGlite) instead.
 *
 * @example
 * const md = await markdownSql({ root: 'content' });
 * const posts = await md.sql`select id, title from posts where draft = ${false} order by id`;
 */
export const markdownSql = async (options: MarkdownSqlOptions): Promise<MarkdownSql> => {
  const models = await buildModels(options);
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

  const query = async (statement: string, params: readonly MarkdownSqlParam[] = []) => {
    if (index.isClosed()) {
      throw closedError();
    }
    return runQuery(engine, statement, params);
  };

  const infos = models.map(tableInfo);
  const { isClosed: _, ...rest } = index;
  return {
    ...rest,
    query,
    sql: (strings, ...values) => query(strings.join('?'), values),
    tables: () => infos,
  };
};

export type { ColumnDefinition, ColumnType, MarkdownSqlTableOptions };
