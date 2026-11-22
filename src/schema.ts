import { createHash } from 'node:crypto';
import { getTableColumns, is } from 'drizzle-orm';
import { getTableConfig, type SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
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

/** Keys of `TSchema` whose values are Drizzle SQLite tables (relations and other values are skipped). */
export type TableKeys<TSchema> = {
  [K in keyof TSchema]: TSchema[K] extends SQLiteTable ? K : never;
}[keyof TSchema] &
  string;

export type TablesOptions<TSchema> = { readonly [K in TableKeys<TSchema>]?: TableOptions };

export type ColumnRole = 'key' | 'body' | 'data';

export interface ColumnModel {
  /** Property name in the Drizzle table, also the frontmatter key. */
  readonly key: string;
  /** SQL column name. */
  readonly name: string;
  readonly role: ColumnRole;
  readonly column: SQLiteColumn;
}

export interface TableModel {
  /** Key of the table in the schema object. */
  readonly schemaKey: string;
  /** SQL table name. */
  readonly name: string;
  /** Folder relative to root. */
  readonly dir: string;
  readonly table: SQLiteTable;
  readonly columns: readonly ColumnModel[];
  readonly keyColumn: ColumnModel;
  readonly ddl: string;
}

export const quoteIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`;

const columnDdl = (model: ColumnModel): string => {
  const { column } = model;
  const parts = [quoteIdentifier(model.name), column.getSQLType()];
  if (column.notNull) {
    parts.push('NOT NULL');
  }
  return parts.join(' ');
};

const tableDdl = (name: string, columns: readonly ColumnModel[], primaryKey: readonly string[]) => {
  const definitions = columns.map(columnDdl);
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

const buildTableModel = (
  schemaKey: string,
  table: SQLiteTable,
  options: TableOptions,
): TableModel => {
  const config = getTableConfig(table);
  const keyName = options.key ?? 'id';
  const bodyName = options.body ?? 'body';
  const columns = Object.entries(getTableColumns(table)).map(
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
    ...config.columns.filter((column) => column.primary).map((column) => column.name),
    ...config.primaryKeys.flatMap((pk) => pk.columns.map((column) => column.name)),
  ];
  return {
    schemaKey,
    name: config.name,
    dir: options.dir ?? config.name,
    table,
    columns,
    keyColumn,
    ddl: tableDdl(config.name, columns, primaryKey),
  };
};

/** Picks the Drizzle SQLite tables out of a schema object and builds their models. */
export const buildModels = <TSchema extends Record<string, object>>(
  schema: TSchema,
  tables: TablesOptions<TSchema> = {},
): readonly TableModel[] => {
  const options: Readonly<Record<string, TableOptions | undefined>> = tables;
  const models = Object.entries(schema).flatMap(([schemaKey, value]) =>
    is(value, SQLiteTable) ? [buildTableModel(schemaKey, value, options[schemaKey] ?? {})] : [],
  );
  if (models.length === 0) {
    throw createDrizzleMdError('CONFIG', 'The schema has no Drizzle SQLite tables.');
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
