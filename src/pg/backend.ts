import type { PGlite, Transaction } from '@electric-sql/pglite';
import type { RowValues } from '../coerce.js';
import { quoteIdentifier, type TableModel } from '../model.js';
import type { IndexBackend } from '../store.js';

/** Values MarkdownSQL binds to a PGlite statement or writes to a COPY stream. */
export type PgParam = string | number | boolean | null | Uint8Array;

/** Narrows whatever a Drizzle pg column's `mapToDriverValue` returned to a bindable value. */
export const toPgParam = <T>(value: T): PgParam => {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof Uint8Array) {
    return value;
  }
  throw new TypeError(`Cannot bind a value of type ${typeof value} to Postgres.`);
};

/** One field in COPY's text format: `\N` for null, with backslash, tab and newlines escaped. */
const copyField = (value: PgParam): string => {
  if (value === null) {
    return '\\N';
  }
  const text =
    value instanceof Uint8Array ? `\\x${Buffer.from(value).toString('hex')}` : `${value}`;
  return text
    .replaceAll('\\', '\\\\')
    .replaceAll('\t', '\\t')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r');
};

const columnList = (row: RowValues<PgParam>): string => row.columns.map(quoteIdentifier).join(', ');

type RowGroup = readonly [RowValues<PgParam>, ...RowValues<PgParam>[]];

/** Loads rows that share a column list with one `COPY … FROM '/dev/blob'`, the fastest path into PGlite. */
const copyRows = async (tx: Transaction, table: string, rows: RowGroup) => {
  const text = rows.map((row) => `${row.params.map(copyField).join('\t')}\n`).join('');
  await tx.query(`COPY ${table} (${columnList(rows[0])}) FROM '/dev/blob'`, [], {
    blob: new Blob([text]),
  });
};

const insertRow = async (tx: Transaction, table: string, row: RowValues<PgParam>) => {
  const placeholders = row.params.map((_, index) => `$${index + 1}`).join(', ');
  await tx.query(`INSERT INTO ${table} (${columnList(row)}) VALUES (${placeholders})`, [
    ...row.params,
  ]);
};

/** Groups rows by their column list, so each group shares one COPY header. */
const byColumns = (rows: readonly RowValues<PgParam>[]): RowGroup[] => {
  const groups = new Map<string, RowGroup>();
  for (const row of rows) {
    const key = row.columns.join('\0');
    const group = groups.get(key);
    groups.set(key, group === undefined ? [row] : [...group, row]);
  }
  return [...groups.values()];
};

/**
 * The PGlite index. MarkdownSQL writes as the session's superuser in its own transaction; PGlite
 * runs transactions one at a time, so writes never interleave with a user query.
 */
export const createPgliteBackend = (client: PGlite): IndexBackend<PgParam> => {
  return {
    toParam: toPgParam,
    evaluate: async (query) => {
      const result = await client.query<[string | null]>(query.sql, [...query.params], {
        rowMode: 'array',
      });
      return result.rows[0]?.[0] ?? null;
    },
    apply: (model: TableModel, changes) =>
      client.transaction(async (tx) => {
        const table = quoteIdentifier(model.name);
        if (changes.deleteKeys.length > 0) {
          await tx.query(
            `DELETE FROM ${table} WHERE ${quoteIdentifier(model.keyColumn.name)} = ANY($1)`,
            [changes.deleteKeys],
          );
        }
        for (const group of byColumns(changes.rows)) {
          if (group.length === 1) {
            await insertRow(tx, table, group[0]);
          } else {
            await copyRows(tx, table, group);
          }
        }
      }),
  };
};
