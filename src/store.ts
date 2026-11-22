import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { buildRow, type SqlEvaluator } from './coerce.js';
import type { Engine, SqlParam } from './engine.js';
import type { Diagnostic } from './errors.js';
import { parseMarkdown } from './frontmatter.js';
import { quoteIdentifier, type TableModel } from './schema.js';

export type ChangeType = 'add' | 'change' | 'unlink' | 'invalid';

/** One file whose row was added, changed, removed, or dropped because it became invalid. */
export interface ChangeEvent {
  readonly type: ChangeType;
  /** Schema key of the table. */
  readonly table: string;
  /** File path relative to `root`, with forward slashes. */
  readonly file: string;
  /** File name without extension, which is the row's key. */
  readonly key: string;
  readonly diagnostics: readonly Diagnostic[];
}

export interface TableReport {
  readonly table: string;
  readonly dir: string;
  /** Files loaded as rows. */
  readonly rows: number;
  /** Files left out because of diagnostics. */
  readonly skipped: number;
  /** Frontmatter keys that match no column, with the number of files that use each. */
  readonly unknownKeys: Readonly<Record<string, number>>;
}

interface FileEntry {
  readonly checksum: string;
  /** Key bound in SQLite, or undefined when the file is invalid and has no row. */
  readonly key: SqlParam | undefined;
  readonly diagnostics: readonly Diagnostic[];
  readonly unknownKeys: readonly string[];
}

export interface TableState {
  readonly model: TableModel;
  readonly absoluteDir: string;
  readonly files: Map<string, FileEntry>;
}

export interface StoreOptions {
  readonly engine: Engine;
  readonly models: readonly TableModel[];
  readonly root: string;
  readonly extensions: readonly string[];
  readonly evaluate: SqlEvaluator;
  readonly onDiagnostic: (diagnostic: Diagnostic) => void;
}

export interface Store {
  readonly tables: readonly TableState[];
  readonly isRowFile: (fileName: string) => boolean;
  readonly syncFile: (state: TableState, fileName: string) => Promise<ChangeEvent | undefined>;
  readonly syncTable: (state: TableState) => Promise<ChangeEvent[]>;
  readonly syncAll: () => Promise<ChangeEvent[]>;
  readonly diagnostics: () => Diagnostic[];
  readonly report: () => TableReport[];
}

const TEMP_SUFFIXES = ['~', '.swp', '.swx', '.tmp', '.bak'];

const errorCode = <T>(error: T): string | undefined =>
  error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;

const errorMessage = <T>(error: T): string =>
  error instanceof Error ? error.message : String(error);

export const createStore = (options: StoreOptions): Store => {
  const { engine, evaluate, onDiagnostic } = options;
  const extensions = options.extensions.map((extension) => extension.toLowerCase());

  const tables = options.models.map(
    (model): TableState => ({
      model,
      absoluteDir: join(options.root, model.dir),
      files: new Map(),
    }),
  );

  const isRowFile = (fileName: string): boolean => {
    const lower = fileName.toLowerCase();
    return (
      !fileName.startsWith('.') &&
      !fileName.startsWith('#') &&
      !TEMP_SUFFIXES.some((suffix) => lower.endsWith(suffix)) &&
      extensions.some((extension) => lower.endsWith(extension) && lower.length > extension.length)
    );
  };

  const stemOf = (fileName: string): string => {
    const lower = fileName.toLowerCase();
    const extension = extensions.find((candidate) => lower.endsWith(candidate)) ?? '';
    return fileName.slice(0, fileName.length - extension.length);
  };

  const relativePath = (state: TableState, fileName: string): string =>
    relative(options.root, join(state.absoluteDir, fileName)).split(sep).join('/');

  const writing = <T>(task: () => T): T => {
    engine.exec('PRAGMA query_only = OFF');
    engine.exec('BEGIN');
    try {
      const result = task();
      engine.exec('COMMIT');
      return result;
    } catch (error) {
      engine.exec('ROLLBACK');
      throw error;
    } finally {
      engine.exec('PRAGMA query_only = ON');
    }
  };

  const deleteSql = (model: TableModel) =>
    `DELETE FROM ${quoteIdentifier(model.name)} WHERE ${quoteIdentifier(model.keyColumn.name)} = ?`;

  const deleteRow = (model: TableModel, key: SqlParam) => {
    writing(() => engine.run(deleteSql(model), [key]));
  };

  const event = (
    type: ChangeEvent['type'],
    state: TableState,
    fileName: string,
    diagnostics: readonly Diagnostic[] = [],
  ): ChangeEvent => ({
    type,
    table: state.model.schemaKey,
    file: relativePath(state, fileName),
    key: stemOf(fileName),
    diagnostics,
  });

  const removeFile = (state: TableState, fileName: string): ChangeEvent | undefined => {
    const previous = state.files.get(fileName);
    if (previous === undefined) {
      return undefined;
    }
    if (previous.key !== undefined) {
      deleteRow(state.model, previous.key);
    }
    state.files.delete(fileName);
    return event('unlink', state, fileName);
  };

  const markInvalid = (
    state: TableState,
    fileName: string,
    checksum: string,
    diagnostics: readonly Diagnostic[],
    unknownKeys: readonly string[] = [],
  ): ChangeEvent => {
    const previous = state.files.get(fileName);
    if (previous?.key !== undefined) {
      deleteRow(state.model, previous.key);
    }
    state.files.set(fileName, { checksum, key: undefined, diagnostics, unknownKeys });
    for (const diagnostic of diagnostics) {
      onDiagnostic(diagnostic);
    }
    return event('invalid', state, fileName, diagnostics);
  };

  const syncFile = async (
    state: TableState,
    fileName: string,
  ): Promise<ChangeEvent | undefined> => {
    if (!isRowFile(fileName)) {
      return undefined;
    }
    const file = relativePath(state, fileName);
    const diagnostic = (code: Diagnostic['code'], message: string): Diagnostic => ({
      code,
      table: state.model.schemaKey,
      file,
      message,
    });
    let source: string;
    try {
      source = await readFile(join(state.absoluteDir, fileName), 'utf8');
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return removeFile(state, fileName);
      }
      if (code === 'EISDIR') {
        return undefined;
      }
      return markInvalid(state, fileName, '', [diagnostic('read-error', errorMessage(error))]);
    }
    const checksum = createHash('sha256').update(source).digest('hex');
    const previous = state.files.get(fileName);
    if (previous?.checksum === checksum) {
      return undefined;
    }
    const parsed = parseMarkdown(source);
    if (!parsed.ok) {
      return markInvalid(state, fileName, checksum, [
        diagnostic('invalid-frontmatter', parsed.message),
      ]);
    }
    const outcome = buildRow(state.model, parsed.file, stemOf(fileName), file, evaluate);
    if (!outcome.ok) {
      return markInvalid(state, fileName, checksum, outcome.diagnostics, outcome.unknownKeys);
    }
    const { model } = state;
    const { row } = outcome;
    const insertSql = `INSERT INTO ${quoteIdentifier(model.name)} (${row.columns
      .map(quoteIdentifier)
      .join(', ')}) VALUES (${row.columns.map(() => '?').join(', ')})`;
    try {
      writing(() => {
        if (previous?.key !== undefined) {
          engine.run(deleteSql(model), [previous.key]);
        }
        engine.run(deleteSql(model), [row.key]);
        engine.run(insertSql, row.params);
      });
    } catch (error) {
      return markInvalid(state, fileName, checksum, [diagnostic('sql-error', errorMessage(error))]);
    }
    state.files.set(fileName, {
      checksum,
      key: row.key,
      diagnostics: [],
      unknownKeys: outcome.unknownKeys,
    });
    return event(previous?.key === undefined ? 'add' : 'change', state, fileName);
  };

  const listFiles = async (state: TableState): Promise<string[]> => {
    try {
      const entries = await readdir(state.absoluteDir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && isRowFile(entry.name))
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return [];
      }
      throw error;
    }
  };

  const syncTable = async (state: TableState): Promise<ChangeEvent[]> => {
    const present = await listFiles(state);
    const events: ChangeEvent[] = [];
    for (const fileName of [...state.files.keys()]) {
      if (!present.includes(fileName)) {
        const removed = removeFile(state, fileName);
        if (removed !== undefined) {
          events.push(removed);
        }
      }
    }
    for (const fileName of present) {
      const changed = await syncFile(state, fileName);
      if (changed !== undefined) {
        events.push(changed);
      }
    }
    return events;
  };

  const syncAll = async (): Promise<ChangeEvent[]> => {
    const events: ChangeEvent[] = [];
    for (const state of tables) {
      events.push(...(await syncTable(state)));
    }
    return events;
  };

  const diagnostics = (): Diagnostic[] =>
    tables.flatMap((state) => [...state.files.values()].flatMap((entry) => entry.diagnostics));

  const report = (): TableReport[] =>
    tables.map((state) => {
      const entries = [...state.files.values()];
      const counts = new Map<string, number>();
      for (const key of entries.flatMap((entry) => entry.unknownKeys)) {
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const unknownKeys = Object.fromEntries([...counts].sort(([a], [b]) => a.localeCompare(b)));
      return {
        table: state.model.schemaKey,
        dir: state.model.dir,
        rows: entries.filter((entry) => entry.key !== undefined).length,
        skipped: entries.filter((entry) => entry.key === undefined).length,
        unknownKeys,
      };
    });

  return { tables, isRowFile, syncFile, syncTable, syncAll, diagnostics, report };
};
