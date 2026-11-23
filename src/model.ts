import { createHash } from 'node:crypto';
import type { JsonValue } from './json.js';

/** Values a column spec accepts once frontmatter has been coerced. */
export type ColumnInput = JsonValue | Date | bigint | readonly ColumnInput[];

/**
 * How frontmatter values are checked and converted for a column. The names follow Drizzle's
 * `dataType`, so the Drizzle adapters map their columns one to one.
 */
export type ValueKind =
  | 'string'
  | 'number'
  | 'bigint'
  | 'boolean'
  | 'date'
  | 'array'
  | 'json'
  | 'custom'
  | 'unsupported';

export type ColumnRole = 'key' | 'body' | 'data';

/** A SQL statement compiled for the index database, e.g. a SQL column default. */
export interface CompiledQuery<TParam> {
  readonly sql: string;
  readonly params: readonly TParam[];
}

export type DefaultValue<TParam> =
  | { readonly found: true; readonly param: TParam }
  | { readonly found: false };

/** How the index database binds values and evaluates SQL defaults. */
export interface RowContext<TParam> {
  /** Narrows whatever a column's driver mapping returned to a bindable value. */
  readonly toParam: <T>(value: T) => TParam;
  /** Runs a compiled `select <expression>` and returns its single value. */
  readonly evaluate: (query: CompiledQuery<TParam>) => Promise<TParam>;
}

/**
 * Everything the loader needs to know about one column, independent of Drizzle. The core builds
 * these from sqlmd column types; `sqlmd/drizzle` and `sqlmd/pg` build them from Drizzle columns.
 */
export interface ColumnSpec {
  readonly kind: ValueKind;
  /** SQL type, e.g. `integer`. Used for integer checks and messages. */
  readonly sqlType: string;
  readonly notNull: boolean;
  /** Allowed values of a text column. */
  readonly enumValues?: readonly string[];
  /** Element spec of a typed array column (Postgres arrays). */
  readonly element?: ColumnSpec;
  /** Column type name shown when the kind is `unsupported`. */
  readonly typeName: string;
  /** Converts a coerced value to a bound parameter. */
  readonly bind: <TParam>(value: ColumnInput, toParam: <T>(value: T) => TParam) => TParam;
  /** The value used when the frontmatter has no value for this column. */
  readonly resolveDefault: <TParam>(context: RowContext<TParam>) => Promise<DefaultValue<TParam>>;
}

export interface ColumnModel {
  /** Frontmatter key (the Drizzle property name, or the sqlmd column name). */
  readonly key: string;
  /** SQL column name. */
  readonly name: string;
  readonly role: ColumnRole;
  readonly spec: ColumnSpec;
}

export interface TableModel {
  /** Name of the table in the user's options or schema object. */
  readonly schemaKey: string;
  /** SQL table name. */
  readonly name: string;
  /** Folder relative to root. */
  readonly dir: string;
  readonly columns: readonly ColumnModel[];
  readonly keyColumn: ColumnModel;
  readonly ddl: string;
}

/** Per-table settings. Every field is optional. */
export interface TableOptions {
  /** Folder under `root` that holds this table's files. Defaults to the SQL table name. */
  readonly dir?: string;
  /** Name of the column filled from the file name (without extension). Defaults to `id`. */
  readonly key?: string;
  /**
   * Name of the column filled from the markdown body. Defaults to `body`; when the table has no
   * such column the body is not stored. Pass `false` to never store it.
   */
  readonly body?: string | false;
}

export const quoteIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/**
 * A hash of everything that shapes the index: table and column names, SQL types, nullability,
 * folders and the key and body columns. A future on-disk cache rebuilds when it changes.
 */
export const schemaHash = (models: readonly TableModel[]): string => {
  const shape = models.map((model) => ({
    table: model.name,
    dir: model.dir,
    ddl: model.ddl,
    columns: model.columns.map((column) => [column.key, column.role, column.spec.kind]),
  }));
  return createHash('sha256').update(JSON.stringify(shape)).digest('hex');
};
