import {
  type Column,
  getTableColumns,
  getTableName,
  is,
  type Query,
  SQL,
  sql,
  type Table,
} from 'drizzle-orm';
import { PgArray } from 'drizzle-orm/pg-core';
import { getTableConfig, SQLiteSyncDialect, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { createMdqlError } from '../errors.js';
import {
  type ColumnModel,
  type ColumnRole,
  type ColumnSpec,
  quoteIdentifier,
  type TableModel,
  type TableOptions,
  type ValueKind,
} from '../model.js';

export type { TableOptions } from '../model.js';

/**
 * Keys of `TSchema` whose values are Drizzle tables of the `TTable` kind (SQLite by default).
 * Relations and other values are skipped.
 */
export type TableKeys<TSchema, TTable extends Table = SQLiteTable> = {
  [K in keyof TSchema]: TSchema[K] extends TTable ? K : never;
}[keyof TSchema] &
  string;

export type TablesOptions<TSchema, TTable extends Table = SQLiteTable> = {
  readonly [K in TableKeys<TSchema, TTable>]?: TableOptions;
};

/** A column model that keeps its Drizzle column, for dialect-specific DDL such as enums. */
export interface DrizzleColumnModel extends ColumnModel {
  readonly column: Column;
}

/** A table model that keeps its Drizzle table, e.g. to read indexes from its extra config. */
export interface DrizzleTableModel extends TableModel {
  readonly table: Table;
  readonly columns: readonly DrizzleColumnModel[];
  readonly keyColumn: DrizzleColumnModel;
}

/** What differs between SQL dialects when tables are turned into models. */
export interface TableDialect<TTable extends Table> {
  /** Dialect name used in error messages, e.g. `SQLite`. */
  readonly label: string;
  readonly isTable: (value: object) => value is TTable;
  /** Column names of primary keys declared with `primaryKey()` in the table's extra config. */
  readonly compositePrimaryKeys: (table: TTable) => readonly string[];
  /** SQL type of a column in `CREATE TABLE`. */
  readonly columnType: (column: Column) => string;
  /** Throws a `CONFIG` error for tables the dialect cannot index. */
  readonly checkTable?: (schemaKey: string, table: TTable) => void;
  /** Compiles `select <expression>` for evaluating a SQL column default. */
  readonly compileDefault: (expression: SQL) => Query;
}

const sqliteSync = new SQLiteSyncDialect();

export const sqliteDialect: TableDialect<SQLiteTable> = {
  label: 'SQLite',
  isTable: (value): value is SQLiteTable => is(value, SQLiteTable),
  compositePrimaryKeys: (table) =>
    getTableConfig(table).primaryKeys.flatMap((pk) => pk.columns.map((column) => column.name)),
  columnType: (column) => column.getSQLType(),
  compileDefault: (expression) => sqliteSync.sqlToQuery(sql`select ${expression}`),
};

const KINDS: readonly ValueKind[] = [
  'string',
  'number',
  'bigint',
  'boolean',
  'date',
  'array',
  'json',
  'custom',
];

const kindOf = (column: Column): ValueKind =>
  KINDS.find((kind) => kind === column.dataType) ?? 'unsupported';

/** Describes a Drizzle column to the Drizzle-free loader. */
export const columnSpec = (
  column: Column,
  compileDefault: (expression: SQL) => Query,
): ColumnSpec => {
  const element = is(column, PgArray) ? columnSpec(column.baseColumn, compileDefault) : undefined;
  const enumValues: readonly string[] | undefined = column.enumValues;
  return {
    kind: kindOf(column),
    sqlType: column.getSQLType(),
    notNull: column.notNull,
    ...(enumValues === undefined ? {} : { enumValues }),
    ...(element === undefined ? {} : { element }),
    typeName: column.columnType,
    bind: (value, toParam) => toParam(column.mapToDriverValue(value)),
    resolveDefault: async (context) => {
      const fromDefault = column.defaultFn === undefined ? column.default : column.defaultFn();
      if (fromDefault === undefined) {
        return { found: false };
      }
      if (is(fromDefault, SQL)) {
        const query = compileDefault(fromDefault);
        return {
          found: true,
          param: await context.evaluate({
            sql: query.sql,
            params: query.params.map(context.toParam),
          }),
        };
      }
      return { found: true, param: context.toParam(column.mapToDriverValue(fromDefault)) };
    },
  };
};

const columnDdl = (model: DrizzleColumnModel, columnType: (column: Column) => string): string => {
  const { column } = model;
  const parts = [quoteIdentifier(model.name), columnType(column)];
  if (column.notNull) {
    parts.push('NOT NULL');
  }
  return parts.join(' ');
};

const tableDdl = (
  name: string,
  columns: readonly DrizzleColumnModel[],
  primaryKey: readonly string[],
  columnType: (column: Column) => string,
) => {
  const definitions = columns.map((model) => columnDdl(model, columnType));
  if (primaryKey.length > 0) {
    definitions.push(`PRIMARY KEY (${primaryKey.map(quoteIdentifier).join(', ')})`);
  }
  return `CREATE TABLE ${quoteIdentifier(name)} (${definitions.join(', ')})`;
};

const roleOf = (key: string, keyName: string, bodyName: string | false): ColumnRole => {
  if (key === keyName) {
    return 'key';
  }
  return key === bodyName ? 'body' : 'data';
};

const buildTableModel = <TTable extends Table>(
  schemaKey: string,
  table: TTable,
  options: TableOptions,
  dialect: TableDialect<TTable>,
): DrizzleTableModel => {
  dialect.checkTable?.(schemaKey, table);
  const name = getTableName(table);
  const keyName = options.key ?? 'id';
  const bodyName = options.body ?? 'body';
  const tableColumns: Readonly<Record<string, Column>> = getTableColumns(table);
  const columns = Object.entries(tableColumns).map(
    ([key, column]): DrizzleColumnModel => ({
      key,
      name: column.name,
      role: roleOf(key, keyName, bodyName),
      column,
      spec: columnSpec(column, dialect.compileDefault),
    }),
  );
  const generated = columns.find((model) => model.column.generated !== undefined);
  if (generated !== undefined) {
    throw createMdqlError(
      'CONFIG',
      `Table "${schemaKey}": generated column "${generated.key}" is not supported yet.`,
    );
  }
  const keyColumn = columns.find((model) => model.role === 'key');
  if (keyColumn === undefined) {
    throw createMdqlError(
      'CONFIG',
      `Table "${schemaKey}" has no column "${keyName}" for the file name. Add one or set tables.${schemaKey}.key.`,
    );
  }
  const bodyColumn = columns.find((model) => model.role === 'body');
  if (options.body !== undefined && options.body !== false && bodyColumn === undefined) {
    throw createMdqlError(
      'CONFIG',
      `Table "${schemaKey}" has no column "${options.body}" for the markdown body.`,
    );
  }
  const primaryKey = [
    ...columns.filter((model) => model.column.primary).map((model) => model.name),
    ...dialect.compositePrimaryKeys(table),
  ];
  return {
    schemaKey,
    name,
    dir: options.dir ?? name,
    table,
    columns,
    keyColumn,
    ddl: tableDdl(name, columns, primaryKey, dialect.columnType),
  };
};

/** Picks the dialect's Drizzle tables out of a schema object and builds their models. */
export const buildModels = <TSchema extends Record<string, object>, TTable extends Table>(
  schema: TSchema,
  tables: TablesOptions<TSchema, TTable> = {},
  dialect: TableDialect<TTable>,
): readonly DrizzleTableModel[] => {
  const options: Readonly<Record<string, TableOptions | undefined>> = tables;
  const models = Object.entries(schema).flatMap(([schemaKey, value]) =>
    dialect.isTable(value)
      ? [buildTableModel(schemaKey, value, options[schemaKey] ?? {}, dialect)]
      : [],
  );
  if (models.length === 0) {
    throw createMdqlError('CONFIG', `The schema has no Drizzle ${dialect.label} tables.`);
  }
  const unknownOptions = Object.keys(options).filter(
    (key) => !models.some((model) => model.schemaKey === key),
  );
  if (unknownOptions.length > 0) {
    throw createMdqlError(
      'CONFIG',
      `tables has options for ${unknownOptions.map((key) => `"${key}"`).join(', ')}, which are not tables in the schema.`,
    );
  }
  const names = new Set<string>();
  for (const model of models) {
    if (names.has(model.name)) {
      throw createMdqlError('CONFIG', `Two schema entries use the SQL table name "${model.name}".`);
    }
    names.add(model.name);
  }
  return models;
};
