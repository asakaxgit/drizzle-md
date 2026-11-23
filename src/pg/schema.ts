import { type Column, is } from 'drizzle-orm';
import {
  getTableConfig,
  PgArray,
  PgEnumColumn,
  PgEnumObjectColumn,
  PgTable,
} from 'drizzle-orm/pg-core';
import { createDrizzleMdError } from '../errors.js';
import { quoteIdentifier, type TableDialect, type TableModel } from '../schema.js';

interface EnumType {
  readonly enumName: string;
  readonly enumValues: readonly string[];
  readonly schema: string | undefined;
}

const enumOf = (column: Column): EnumType | undefined => {
  if (is(column, PgArray)) {
    return enumOf(column.baseColumn);
  }
  if (is(column, PgEnumColumn) || is(column, PgEnumObjectColumn)) {
    return column.enum;
  }
  return undefined;
};

const columnType = (column: Column): string => {
  if (is(column, PgArray)) {
    return `${columnType(column.baseColumn)}[${column.size ?? ''}]`;
  }
  const enumType = enumOf(column);
  return enumType === undefined ? column.getSQLType() : quoteIdentifier(enumType.enumName);
};

export const pgDialect: TableDialect<PgTable> = {
  label: 'Postgres',
  isTable: (value): value is PgTable => is(value, PgTable),
  compositePrimaryKeys: (table) =>
    getTableConfig(table).primaryKeys.flatMap((pk) => pk.columns.map((column) => column.name)),
  columnType,
  checkTable: (schemaKey, table) => {
    const { schema } = getTableConfig(table);
    if (schema !== undefined && schema !== 'public') {
      throw createDrizzleMdError(
        'CONFIG',
        `Table "${schemaKey}" is in the Postgres schema "${schema}". Only tables in the default schema are supported yet.`,
      );
    }
  },
};

const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/** `CREATE TYPE … AS ENUM` for every `pgEnum` the tables use, before their `CREATE TABLE`. */
export const enumDdl = (models: readonly TableModel[]): readonly string[] => {
  const enums = new Map<string, EnumType>();
  for (const column of models.flatMap((model) => model.columns)) {
    const enumType = enumOf(column.column);
    if (enumType === undefined) {
      continue;
    }
    if (enumType.schema !== undefined && enumType.schema !== 'public') {
      throw createDrizzleMdError(
        'CONFIG',
        `Enum "${enumType.enumName}" is in the Postgres schema "${enumType.schema}". Only the default schema is supported yet.`,
      );
    }
    enums.set(enumType.enumName, enumType);
  }
  return [...enums.values()].map(
    (enumType) =>
      `CREATE TYPE ${quoteIdentifier(enumType.enumName)} AS ENUM (${enumType.enumValues
        .map(literal)
        .join(', ')})`,
  );
};
