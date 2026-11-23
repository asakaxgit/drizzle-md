import { is, SQL } from 'drizzle-orm';
import { getTableConfig, IndexedColumn, PgDialect, PgTable } from 'drizzle-orm/pg-core';
import type { DrizzleTableModel } from '../drizzle/schema.js';
import { createMarkdownSqlError } from '../errors.js';
import { quoteIdentifier } from '../model.js';

/** One `CREATE INDEX` statement for an index declared in a `pgTable`. */
export interface IndexStatement {
  /** Schema key of the table. */
  readonly table: string;
  /** Index name, or a description when Postgres picks the name. */
  readonly label: string;
  /** Unique indexes are created before the files load, so a duplicate becomes a `sql-error`. */
  readonly unique: boolean;
  readonly sql: string;
}

type IndexPart = Partial<IndexedColumn | SQL>;
type WithValue = string | number | boolean;

const dialect = new PgDialect();

const unsupported = (table: string, label: string, reason: string) =>
  createMarkdownSqlError('CONFIG', `Table "${table}", index ${label}: ${reason}`);

/** Renders SQL as drizzle-kit does for indexes: unqualified column names, no parameters. */
const renderSql = (expression: SQL, table: string, label: string): string => {
  const query = dialect.sqlToQuery(expression, 'indexes');
  if (query.params.length > 0) {
    throw unsupported(
      table,
      label,
      "expressions and WHERE clauses cannot use bound values. Write literal values into the SQL text (e.g. status = 'published') or use sql.raw().",
    );
  }
  return query.sql;
};

const renderPart = (part: IndexPart, table: string, label: string): string => {
  if (is(part, SQL)) {
    return `(${renderSql(part, table, label)})`;
  }
  if (!is(part, IndexedColumn) || part.name === undefined) {
    throw unsupported(table, label, 'only columns and sql`` expressions can be indexed.');
  }
  const { opClass, order, nulls } = part.indexConfig;
  const words = [quoteIdentifier(part.name)];
  if (opClass !== undefined) {
    words.push(opClass);
  }
  if (order === 'desc') {
    words.push('DESC');
  }
  // Postgres puts nulls last for ascending and first for descending order unless told otherwise.
  if (nulls !== undefined && nulls !== (order === 'desc' ? 'first' : 'last')) {
    words.push(`NULLS ${nulls.toUpperCase()}`);
  }
  return words.join(' ');
};

const isWithValue = <T>(value: T): value is T & WithValue =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

const renderWith = (
  options: Readonly<Record<string, WithValue | object>>,
  table: string,
  label: string,
) =>
  Object.entries(options)
    .map(([key, value]) => {
      if (!isWithValue(value)) {
        throw unsupported(
          table,
          label,
          `WITH option "${key}" must be a string, number or boolean.`,
        );
      }
      return `${key} = ${typeof value === 'string' ? `'${value.replaceAll("'", "''")}'` : value}`;
    })
    .join(', ');

/**
 * `CREATE INDEX` statements for every `index()` and `uniqueIndex()` declared in the models'
 * `pgTable` extra config: columns with operator classes, order and nulls, `sql` expressions,
 * `.using()` methods such as gin or gist, `.where()` and `.with()`. `.concurrently()` is ignored,
 * because the index is built before anyone can query it.
 */
export const indexDdl = (models: readonly DrizzleTableModel[]): readonly IndexStatement[] =>
  models.flatMap((model) => {
    if (!is(model.table, PgTable)) {
      return [];
    }
    return getTableConfig(model.table).indexes.map((index, position): IndexStatement => {
      const { config } = index;
      const label = config.name === undefined ? `#${position + 1}` : `"${config.name}"`;
      const parts = config.columns.map((part) => renderPart(part, model.schemaKey, label));
      const clauses = [
        `CREATE${config.unique ? ' UNIQUE' : ''} INDEX`,
        ...(config.name === undefined ? [] : [quoteIdentifier(config.name)]),
        // `only` is left out: the index tables are never partitioned (and `.using()` always sets it).
        `ON ${quoteIdentifier(model.name)}`,
        ...(config.method === undefined || config.method === 'btree'
          ? []
          : [`USING ${config.method}`]),
        `(${parts.join(', ')})`,
        ...(config.with === undefined || Object.keys(config.with).length === 0
          ? []
          : [`WITH (${renderWith(config.with, model.schemaKey, label)})`]),
        ...(config.where === undefined
          ? []
          : [`WHERE ${renderSql(config.where, model.schemaKey, label)}`]),
      ];
      return { table: model.schemaKey, label, unique: config.unique, sql: clauses.join(' ') };
    });
  });
