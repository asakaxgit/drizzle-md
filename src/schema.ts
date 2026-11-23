import { createHash } from 'node:crypto';
import { type Column, getTableColumns, getTableName, is, type Table } from 'drizzle-orm';
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { createDrizzleMdError } from './errors.js';

/** Per-table settings. Every field is optional. */
export interface TableOptions {
  /** Folder under `root` that holds this table's files. Defaults to the SQL table name. */
  readonly dir?: string;
  /** Property name of the column filled from the file name (without extension). Defaults to `id`. */
  readonly key?: string;
  /**
   * Property name of the column filled from the markdown body. Defaults to `body`; when the
   * table has no such column the body is not stored. Pass `false` to never store it.
   */
  readonly body?: string | false;
}

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

export type ColumnRole = 'key' | 'body' | 'data';

export interface ColumnModel {
  /** Property name in the Drizzle table, also the frontmatter key. */
  readonly key: string;
  /** SQL column name. */
  readonly name: string;
  readonly role: ColumnRole;
  readonly column: Column;
}

export interface TableModel {
  /** Key of the table in the schema object. */
  readonly schemaKey: string;
  /** SQL table name. */
  readonly name: string;
  /** Folder relative to root. */
  readonly dir: string;
  readonly table: Table;
  readonly columns: readonly ColumnModel[];
  readonly keyColumn: ColumnModel;
  readonly ddl: string;
}

export const quoteIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`;

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
}

export const sqliteDialect: TableDialect<SQLiteTable> = {
  label: 'SQLite',
  isTable: (value): value is SQLiteTable => is(value, SQLiteTable),
  compositePrimaryKeys: (table) =>
    getTableConfig(table).primaryKeys.flatMap((pk) => pk.columns.map((column) => column.name)),
  columnType: (column) => column.getSQLType(),
};

const columnDdl = (model: ColumnModel, columnType: (column: Column) => string): string => {
  const { column } = model;
  const parts = [quoteIdentifier(model.name), columnType(column)];
  if (column.notNull) {
    parts.push('NOT NULL');
  }
  return parts.join(' ');
};

const tableDdl = (
  name: string,
  columns: readonly ColumnModel[],
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
): TableModel => {
  dialect.checkTable?.(schemaKey, table);
  const name = getTableName(table);
  const keyName = options.key ?? 'id';
  const bodyName = options.body ?? 'body';
  const tableColumns: Readonly<Record<string, Column>> = getTableColumns(table);
  const columns = Object.entries(tableColumns).map(
    ([key, column]): ColumnModel => ({
      key,
      name: column.name,
      role: roleOf(key, keyName, bodyName),
      column,
    }),
  );
  const generated = columns.find((model) => model.column.generated !== undefined);
  if (generated !== undefined) {
    throw createDrizzleMdError(
      'CONFIG',
      `Table "${schemaKey}": generated column "${generated.key}" is not supported yet.`,
    );
  }
  const keyColumn = columns.find((model) => model.role === 'key');
  if (keyColumn === undefined) {
    throw createDrizzleMdError(
      'CONFIG',
      `Table "${schemaKey}" has no column "${keyName}" for the file name. Add one or set tables.${schemaKey}.key.`,
    );
  }
  const bodyColumn = columns.find((model) => model.role === 'body');
  if (options.body !== undefined && options.body !== false && bodyColumn === undefined) {
    throw createDrizzleMdError(
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
): readonly TableModel[] => {
  const options: Readonly<Record<string, TableOptions | undefined>> = tables;
  const models = Object.entries(schema).flatMap(([schemaKey, value]) =>
    dialect.isTable(value)
      ? [buildTableModel(schemaKey, value, options[schemaKey] ?? {}, dialect)]
      : [],
  );
  if (models.length === 0) {
    throw createDrizzleMdError('CONFIG', `The schema has no Drizzle ${dialect.label} tables.`);
  }
  const unknownOptions = Object.keys(options).filter(
    (key) => !models.some((model) => model.schemaKey === key),
  );
  if (unknownOptions.length > 0) {
    throw createDrizzleMdError(
      'CONFIG',
      `tables has options for ${unknownOptions.map((key) => `"${key}"`).join(', ')}, which are not tables in the schema.`,
    );
  }
  const names = new Set<string>();
  for (const model of models) {
    if (names.has(model.name)) {
      throw createDrizzleMdError(
        'CONFIG',
        `Two schema entries use the SQL table name "${model.name}".`,
      );
    }
    names.add(model.name);
  }
  return models;
};

/**
 * A hash of everything that shapes the index: table and column names, SQL types, nullability,
 * folders and the key and body columns. A future on-disk cache rebuilds when it changes.
 */
export const schemaHash = (models: readonly TableModel[]): string => {
  const shape = models.map((model) => ({
    table: model.name,
    dir: model.dir,
    ddl: model.ddl,
    columns: model.columns.map((column) => [column.key, column.role, column.column.dataType]),
  }));
  return createHash('sha256').update(JSON.stringify(shape)).digest('hex');
};
