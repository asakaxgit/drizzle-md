import type { SqlParam } from './engine.js';
import type { Diagnostic, DiagnosticCode } from './errors.js';
import type { MarkdownFile } from './frontmatter.js';
import type { JsonValue } from './json.js';
import type { ColumnInput, ColumnModel, ColumnSpec, RowContext, TableModel } from './model.js';

type Coerced =
  | { readonly ok: true; readonly value: ColumnInput }
  | { readonly ok: false; readonly code: DiagnosticCode; readonly message: string };

/** One row ready to bind. `TParam` is what the index database accepts as a parameter. */
export interface RowValues<TParam> {
  readonly key: TParam;
  /** SQL column names, in the same order as `params`. */
  readonly columns: readonly string[];
  readonly params: readonly TParam[];
}

export type RowOutcome<TParam> =
  | { readonly ok: true; readonly row: RowValues<TParam>; readonly unknownKeys: readonly string[] }
  | {
      readonly ok: false;
      readonly diagnostics: readonly Diagnostic[];
      readonly unknownKeys: readonly string[];
    };

const ISO_DATE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const INTEGER_TEXT = /^-?\d+$/;
const INTEGER_TYPES: readonly string[] = [
  'integer',
  'smallint',
  'bigint',
  'serial',
  'smallserial',
  'bigserial',
];

const ok = (value: ColumnInput): Coerced => ({ ok: true, value });

const mismatch = (message: string): Coerced => ({ ok: false, code: 'type-mismatch', message });

const describe = (value: JsonValue): string => {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'a list';
  }
  return typeof value === 'object' ? 'a mapping' : `${typeof value} ${JSON.stringify(value)}`;
};

const coerceString = (column: ColumnSpec, value: JsonValue): Coerced => {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    return mismatch(`expected text, got ${describe(value)}`);
  }
  const text = String(value);
  const allowed: readonly string[] | undefined = column.enumValues;
  if (allowed !== undefined && allowed.length > 0 && !allowed.includes(text)) {
    return mismatch(
      `expected one of ${allowed.map((v) => JSON.stringify(v)).join(', ')}, got ${JSON.stringify(text)}`,
    );
  }
  return ok(text);
};

const coerceNumber = (column: ColumnSpec, value: JsonValue): Coerced => {
  if (typeof value !== 'number') {
    return mismatch(`expected a number, got ${describe(value)}`);
  }
  if (INTEGER_TYPES.includes(column.sqlType) && !Number.isInteger(value)) {
    return mismatch(`expected an integer, got ${value}`);
  }
  return ok(value);
};

const coerceBigint = (value: JsonValue): Coerced => {
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return ok(BigInt(value));
  }
  if (typeof value === 'string' && INTEGER_TEXT.test(value)) {
    return ok(BigInt(value));
  }
  return mismatch(`expected an integer, got ${describe(value)}`);
};

const coerceDate = (value: JsonValue): Coerced => {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) {
    return mismatch(
      `expected an ISO 8601 date such as 2026-11-23 or 2026-11-23T09:00:00Z, got ${describe(value)}`,
    );
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? mismatch(`invalid date ${JSON.stringify(value)}`)
    : ok(date);
};

const coerceArray = (column: ColumnSpec, value: JsonValue): Coerced => {
  if (!Array.isArray(value)) {
    return mismatch(`expected a list, got ${describe(value)}`);
  }
  const { element } = column;
  if (element === undefined) {
    return ok(value);
  }
  const items: ColumnInput[] = [];
  for (const [index, item] of value.entries()) {
    if (item === null) {
      return mismatch(`item ${index + 1}: null is not allowed in a list`);
    }
    const coerced = coerceValue(element, item);
    if (!coerced.ok) {
      return { ...coerced, message: `item ${index + 1}: ${coerced.message}` };
    }
    items.push(coerced.value);
  }
  return ok(items);
};

/** Converts one frontmatter value to what the column expects. */
export const coerceValue = (column: ColumnSpec, value: JsonValue): Coerced => {
  switch (column.kind) {
    case 'string':
      return coerceString(column, value);
    case 'number':
      return coerceNumber(column, value);
    case 'bigint':
      return coerceBigint(value);
    case 'boolean':
      return typeof value === 'boolean'
        ? ok(value)
        : mismatch(`expected true or false, got ${describe(value)}`);
    case 'date':
      return coerceDate(value);
    case 'array':
      return coerceArray(column, value);
    case 'json':
    case 'custom':
      return ok(value);
    default:
      return mismatch(`columns of type ${column.typeName} cannot be read from frontmatter`);
  }
};

/** Narrows whatever a column's driver mapping returned to a bindable SQLite value. */
export const toSqlParam = <T>(value: T): SqlParam => {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  if (value instanceof Uint8Array) {
    return value;
  }
  throw new TypeError(`Cannot bind a value of type ${typeof value} to SQLite.`);
};

const keyValue = (model: ColumnModel, stem: string): Coerced => {
  const { kind: dataType } = model.spec;
  if (dataType === 'string') {
    return coerceString(model.spec, stem);
  }
  if ((dataType === 'number' || dataType === 'bigint') && INTEGER_TEXT.test(stem)) {
    return dataType === 'number' ? ok(Number(stem)) : ok(BigInt(stem));
  }
  return {
    ok: false,
    code: 'invalid-key',
    message: `file name "${stem}" is not a valid ${model.spec.sqlType} key`,
  };
};

/** Turns one parsed markdown file into a row for `model`, or diagnostics explaining why not. */
export const buildRow = async <TParam>(
  model: TableModel,
  file: MarkdownFile,
  stem: string,
  relativePath: string,
  context: RowContext<TParam>,
): Promise<RowOutcome<TParam>> => {
  const { toParam } = context;
  const diagnostics: Diagnostic[] = [];
  const columns: string[] = [];
  const params: TParam[] = [];
  let key: TParam = toParam(null);
  const report = (code: DiagnosticCode, column: string, message: string) => {
    diagnostics.push({ code, table: model.schemaKey, file: relativePath, column, message });
  };
  const dataKeys = new Set(model.columns.filter((c) => c.role === 'data').map((c) => c.key));
  const unknownKeys = Object.keys(file.data).filter((k) => !dataKeys.has(k));

  for (const columnModel of model.columns) {
    const { spec: column } = columnModel;
    let coerced: Coerced | undefined;
    if (columnModel.role === 'key') {
      coerced = keyValue(columnModel, stem);
    } else if (columnModel.role === 'body') {
      coerced = ok(file.body);
    } else {
      const raw = Object.hasOwn(file.data, columnModel.key)
        ? file.data[columnModel.key]
        : undefined;
      if (raw === null && !column.notNull) {
        coerced = ok(null);
      } else if (raw !== undefined && raw !== null) {
        coerced = coerceValue(column, raw);
      }
    }
    if (coerced === undefined) {
      const fallback = await column.resolveDefault(context);
      if (fallback.found) {
        columns.push(columnModel.name);
        params.push(fallback.param);
      } else if (column.notNull) {
        report(
          'missing-required',
          columnModel.key,
          `required column "${columnModel.key}" is missing`,
        );
      } else {
        columns.push(columnModel.name);
        params.push(toParam(null));
      }
      continue;
    }
    if (!coerced.ok) {
      report(coerced.code, columnModel.key, coerced.message);
      continue;
    }
    const param = coerced.value === null ? toParam(null) : column.bind(coerced.value, toParam);
    if (columnModel.role === 'key') {
      key = param;
    }
    columns.push(columnModel.name);
    params.push(param);
  }
  if (diagnostics.length > 0) {
    return { ok: false, diagnostics, unknownKeys };
  }
  return { ok: true, row: { key, columns, params }, unknownKeys };
};
