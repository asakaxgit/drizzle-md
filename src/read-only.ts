import { createMdqlError, type MdqlError } from './errors.js';

/** Statements that may reach the index: reads only, after leading comments. */
export const READ_STATEMENT =
  /^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*(?:select|with|values|explain)\b/i;

export const readOnlyError = (statement: string, cause?: Error): MdqlError =>
  createMdqlError(
    'READ_ONLY',
    `mdql is read-only in this version: edit the markdown files instead. Rejected: ${statement.trim().slice(0, 80)}`,
    cause === undefined ? {} : { cause },
  );

export const closedError = (): MdqlError =>
  createMdqlError('CLOSED', 'This mdql instance is closed.');
