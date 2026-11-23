import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { createMarkdownSqlError } from './errors.js';
import { parseMarkdown } from './frontmatter.js';
import type { JsonValue } from './json.js';
import {
  type ColumnModel,
  type ColumnSpec,
  quoteIdentifier,
  type TableModel,
  type TableOptions,
} from './model.js';

/**
 * Column types of the Drizzle-free `markdown-sql` entry point and how each is stored in SQLite:
 *
 * - `text`: TEXT. Numbers and booleans in frontmatter are turned into text.
 * - `integer`: INTEGER; the value must be a whole number.
 * - `real`: REAL.
 * - `boolean`: INTEGER, `1` for true and `0` for false.
 * - `date`: TEXT, an ISO 8601 timestamp such as `2026-11-23T00:00:00.000Z`.
 * - `json`: TEXT holding JSON; query it with SQLite's `json_*` functions.
 */
export type ColumnType = 'text' | 'integer' | 'real' | 'boolean' | 'date' | 'json';

export interface ColumnDefinition {
  readonly type: ColumnType;
  /** A file without this frontmatter key (or with `null`) is reported and left out. */
  readonly required?: boolean;
  /** Allowed values of a `text` column. */
  readonly values?: readonly string[];
}

export interface MarkdownSqlTableOptions extends TableOptions {
  /**
   * Frontmatter columns, by frontmatter key. When left out, the columns are inferred from the
   * files on the first load; see the README for the rules.
   */
  readonly columns?: Readonly<Record<string, ColumnType | ColumnDefinition>>;
}

const SQL_TYPES: Readonly<Record<ColumnType, string>> = {
  text: 'text',
  integer: 'integer',
  real: 'real',
  boolean: 'integer',
  date: 'text',
  json: 'text',
};

const KINDS = {
  text: 'string',
  integer: 'number',
  real: 'number',
  boolean: 'boolean',
  date: 'date',
  json: 'json',
} as const satisfies Record<ColumnType, ColumnSpec['kind']>;

const noDefault: ColumnSpec['resolveDefault'] = async () => ({ found: false });

/** The `ColumnSpec` for a MarkdownSQL column type. */
export const markdownSqlColumnSpec = (definition: ColumnDefinition): ColumnSpec => {
  const { type } = definition;
  return {
    kind: KINDS[type],
    sqlType: SQL_TYPES[type],
    notNull: definition.required ?? false,
    ...(definition.values === undefined ? {} : { enumValues: definition.values }),
    typeName: type,
    bind: (value, toParam) => {
      if (type === 'json') {
        return toParam(JSON.stringify(value));
      }
      return toParam(value instanceof Date ? value.toISOString() : value);
    },
    resolveDefault: noDefault,
  };
};

const COLUMN_TYPES: readonly string[] = Object.keys(SQL_TYPES);

const definitionOf = (
  table: string,
  key: string,
  column: ColumnType | ColumnDefinition,
): ColumnDefinition => {
  const definition = typeof column === 'string' ? { type: column } : column;
  if (!COLUMN_TYPES.includes(definition.type)) {
    throw createMarkdownSqlError(
      'CONFIG',
      `Table "${table}", column "${key}": unknown type "${definition.type}". Use one of ${COLUMN_TYPES.join(', ')}.`,
    );
  }
  if (definition.values !== undefined && definition.type !== 'text') {
    throw createMarkdownSqlError(
      'CONFIG',
      `Table "${table}", column "${key}": values is only allowed on text columns.`,
    );
  }
  return definition;
};

type Observed = 'boolean' | 'integer' | 'real' | 'text' | 'json';

const observe = (value: JsonValue): Observed => {
  if (typeof value === 'boolean') {
    return 'boolean';
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'integer' : 'real';
  }
  return typeof value === 'string' ? 'text' : 'json';
};

/** Picks one column type that holds every observed value. */
const unify = (seen: ReadonlySet<Observed>): ColumnType => {
  if (seen.has('json')) {
    return 'json';
  }
  if (seen.size === 1) {
    const [only] = seen;
    return only ?? 'text';
  }
  if (seen.size === 2 && seen.has('integer') && seen.has('real')) {
    return 'real';
  }
  // Mixed scalars, e.g. `version: 1` and `version: 1.2-beta`: text holds them all.
  return 'text';
};

const isMissingFolder = <T>(error: T): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

/**
 * Infers frontmatter columns from every row file in `dir`. Keys are sorted by name. `null`
 * values are ignored; a key that is only ever `null` becomes `text`. Files that fail to parse are
 * skipped here and reported by the first load.
 */
export const inferColumns = async (
  dir: string,
  extensions: readonly string[],
  reserved: readonly string[],
): Promise<Readonly<Record<string, ColumnType>>> => {
  let names: string[];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    names = entries
      .filter((entry) => entry.isFile() && extensions.includes(extname(entry.name)))
      .map((entry) => entry.name);
  } catch (error) {
    if (isMissingFolder(error)) {
      return {};
    }
    throw error;
  }
  const seen = new Map<string, Set<Observed>>();
  for (const name of names) {
    const parsed = parseMarkdown(await readFile(join(dir, name), 'utf8'));
    if (!parsed.ok) {
      continue;
    }
    for (const [key, value] of Object.entries(parsed.file.data)) {
      if (reserved.includes(key)) {
        continue;
      }
      const types = seen.get(key) ?? new Set<Observed>();
      if (value !== null) {
        types.add(observe(value));
      }
      seen.set(key, types);
    }
  }
  return Object.fromEntries(
    [...seen].sort(([a], [b]) => a.localeCompare(b)).map(([key, types]) => [key, unify(types)]),
  );
};

const keySpec: ColumnSpec = markdownSqlColumnSpec({ type: 'text', required: true });
const bodySpec: ColumnSpec = markdownSqlColumnSpec({ type: 'text', required: true });

/**
 * Builds the model of one table: the key column (TEXT primary key, from the file name), then the
 * frontmatter columns in order, then the body column unless `body` is `false`.
 */
export const buildMarkdownSqlModel = (
  table: string,
  options: TableOptions,
  columns: Readonly<Record<string, ColumnType | ColumnDefinition>>,
): TableModel => {
  const keyName = options.key ?? 'id';
  const bodyName = options.body ?? 'body';
  if (keyName === bodyName) {
    throw createMarkdownSqlError(
      'CONFIG',
      `Table "${table}": key and body cannot both be "${keyName}".`,
    );
  }
  const reserved = Object.keys(columns).find((key) => key === keyName || key === bodyName);
  if (reserved !== undefined) {
    throw createMarkdownSqlError(
      'CONFIG',
      `Table "${table}": column "${reserved}" is already the ${reserved === keyName ? 'key' : 'body'} column.`,
    );
  }
  const keyColumn: ColumnModel = { key: keyName, name: keyName, role: 'key', spec: keySpec };
  const models: ColumnModel[] = [
    keyColumn,
    ...Object.entries(columns).map(
      ([key, column]): ColumnModel => ({
        key,
        name: key,
        role: 'data',
        spec: markdownSqlColumnSpec(definitionOf(table, key, column)),
      }),
    ),
  ];
  if (bodyName !== false) {
    models.push({ key: bodyName, name: bodyName, role: 'body', spec: bodySpec });
  }
  const definitions = models.map((model) => {
    const parts = [quoteIdentifier(model.name), model.spec.sqlType.toUpperCase()];
    if (model.role === 'key') {
      parts.push('PRIMARY KEY');
    }
    if (model.spec.notNull) {
      parts.push('NOT NULL');
    }
    return parts.join(' ');
  });
  return {
    schemaKey: table,
    name: table,
    dir: options.dir ?? table,
    columns: models,
    keyColumn,
    ddl: `CREATE TABLE ${quoteIdentifier(table)} (${definitions.join(', ')})`,
  };
};
