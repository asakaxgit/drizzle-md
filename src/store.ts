import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { buildRow, type RowContext, type RowValues } from './coerce.js';
import type { Diagnostic } from './errors.js';
import { parseMarkdown } from './frontmatter.js';
import type { TableModel } from './schema.js';

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

interface FileEntry<TParam> {
  readonly checksum: string;
  /** Key bound in the index, or undefined when the file is invalid and has no row. */
  readonly key: TParam | undefined;
  readonly diagnostics: readonly Diagnostic[];
  readonly unknownKeys: readonly string[];
}

export interface TableState<TParam> {
  readonly model: TableModel;
  readonly absoluteDir: string;
  readonly files: Map<string, FileEntry<TParam>>;
}

/** Row changes for one table: delete these keys, then insert these rows. */
export interface TableChanges<TParam> {
  readonly deleteKeys: readonly TParam[];
  readonly rows: readonly RowValues<TParam>[];
}

/** The index database behind a store: SQLite or PGlite. */
export interface IndexBackend<TParam> extends RowContext<TParam> {
  /**
   * Applies `changes` to one table atomically. When it rejects, nothing changed; the store then
   * retries file by file to find the one that failed.
   */
  readonly apply: (model: TableModel, changes: TableChanges<TParam>) => Promise<void>;
}

export interface StoreOptions<TParam> {
  readonly backend: IndexBackend<TParam>;
  readonly models: readonly TableModel[];
  readonly root: string;
  readonly extensions: readonly string[];
  readonly onDiagnostic: (diagnostic: Diagnostic) => void;
}

export interface Store<TParam> {
  readonly tables: readonly TableState<TParam>[];
  readonly isRowFile: (fileName: string) => boolean;
  readonly syncFile: (
    state: TableState<TParam>,
    fileName: string,
  ) => Promise<ChangeEvent | undefined>;
  readonly syncTable: (state: TableState<TParam>) => Promise<ChangeEvent[]>;
  readonly syncAll: () => Promise<ChangeEvent[]>;
  readonly diagnostics: () => Diagnostic[];
  readonly report: () => TableReport[];
}

/** What reading one file decided. Nothing is applied until `commit`. */
type FilePlan<TParam> =
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'remove' }
  | {
      readonly kind: 'invalid';
      readonly checksum: string;
      readonly diagnostics: readonly Diagnostic[];
      readonly unknownKeys: readonly string[];
    }
  | {
      readonly kind: 'row';
      readonly checksum: string;
      readonly row: RowValues<TParam>;
      readonly unknownKeys: readonly string[];
    };

interface PlannedFile<TParam> {
  readonly fileName: string;
  readonly plan: FilePlan<TParam>;
}

const TEMP_SUFFIXES = ['~', '.swp', '.swx', '.tmp', '.bak'];

const errorCode = <T>(error: T): string | undefined =>
  error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;

const errorMessage = <T>(error: T): string =>
  error instanceof Error ? error.message : String(error);

export const createStore = <TParam>(options: StoreOptions<TParam>): Store<TParam> => {
  const { backend, onDiagnostic } = options;
  const extensions = options.extensions.map((extension) => extension.toLowerCase());

  const tables = options.models.map(
    (model): TableState<TParam> => ({
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

  const relativePath = (state: TableState<TParam>, fileName: string): string =>
    relative(options.root, join(state.absoluteDir, fileName)).split(sep).join('/');

  const event = (
    type: ChangeEvent['type'],
    state: TableState<TParam>,
    fileName: string,
    diagnostics: readonly Diagnostic[] = [],
  ): ChangeEvent => ({
    type,
    table: state.model.schemaKey,
    file: relativePath(state, fileName),
    key: stemOf(fileName),
    diagnostics,
  });

  const planFile = async (
    state: TableState<TParam>,
    fileName: string,
  ): Promise<FilePlan<TParam>> => {
    if (!isRowFile(fileName)) {
      return { kind: 'unchanged' };
    }
    const file = relativePath(state, fileName);
    const invalid = (
      checksum: string,
      diagnostics: readonly Diagnostic[],
      unknownKeys: readonly string[] = [],
    ): FilePlan<TParam> => ({ kind: 'invalid', checksum, diagnostics, unknownKeys });
    let source: string;
    try {
      source = await readFile(join(state.absoluteDir, fileName), 'utf8');
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return { kind: 'remove' };
      }
      if (code === 'EISDIR') {
        return { kind: 'unchanged' };
      }
      return invalid('', [
        { code: 'read-error', table: state.model.schemaKey, file, message: errorMessage(error) },
      ]);
    }
    const checksum = createHash('sha256').update(source).digest('hex');
    if (state.files.get(fileName)?.checksum === checksum) {
      return { kind: 'unchanged' };
    }
    const parsed = parseMarkdown(source);
    if (!parsed.ok) {
      return invalid(checksum, [
        {
          code: 'invalid-frontmatter',
          table: state.model.schemaKey,
          file,
          message: parsed.message,
        },
      ]);
    }
    const outcome = await buildRow(state.model, parsed.file, stemOf(fileName), file, backend);
    if (!outcome.ok) {
      return invalid(checksum, outcome.diagnostics, outcome.unknownKeys);
    }
    return { kind: 'row', checksum, row: outcome.row, unknownKeys: outcome.unknownKeys };
  };

  /** Updates the file state after its change was applied and returns the event. */
  const record = (
    state: TableState<TParam>,
    item: PlannedFile<TParam>,
  ): ChangeEvent | undefined => {
    const { fileName, plan } = item;
    const entries = state.files;
    const previous = entries.get(fileName);
    switch (plan.kind) {
      case 'unchanged':
        return undefined;
      case 'remove':
        if (previous === undefined) {
          return undefined;
        }
        entries.delete(fileName);
        return event('unlink', state, fileName);
      case 'invalid':
        entries.set(fileName, {
          checksum: plan.checksum,
          key: undefined,
          diagnostics: plan.diagnostics,
          unknownKeys: plan.unknownKeys,
        });
        for (const diagnostic of plan.diagnostics) {
          onDiagnostic(diagnostic);
        }
        return event('invalid', state, fileName, plan.diagnostics);
      case 'row':
        entries.set(fileName, {
          checksum: plan.checksum,
          key: plan.row.key,
          diagnostics: [],
          unknownKeys: plan.unknownKeys,
        });
        return event(previous?.key === undefined ? 'add' : 'change', state, fileName);
    }
  };

  const changesFor = (
    state: TableState<TParam>,
    items: readonly PlannedFile<TParam>[],
  ): TableChanges<TParam> => {
    const entries = state.files;
    const deleteKeys: TParam[] = [];
    const rows: RowValues<TParam>[] = [];
    for (const { fileName, plan } of items) {
      const previousKey = entries.get(fileName)?.key;
      if (previousKey !== undefined) {
        deleteKeys.push(previousKey);
      }
      if (plan.kind === 'row') {
        deleteKeys.push(plan.row.key);
        rows.push(plan.row);
      }
    }
    return { deleteKeys, rows };
  };

  /**
   * Applies planned files for one table in one batch. When the batch fails, each file is applied
   * on its own, and a file whose row the database rejects is reported as a `sql-error`.
   */
  const commit = async (
    state: TableState<TParam>,
    planned: readonly PlannedFile<TParam>[],
  ): Promise<ChangeEvent[]> => {
    const items = planned.filter((item) => item.plan.kind !== 'unchanged');
    const changes = changesFor(state, items);
    try {
      if (changes.deleteKeys.length > 0 || changes.rows.length > 0) {
        await backend.apply(state.model, changes);
      }
    } catch (error) {
      const [only] = items;
      if (items.length > 1) {
        const events: ChangeEvent[] = [];
        for (const item of items) {
          events.push(...(await commit(state, [item])));
        }
        return events;
      }
      if (only === undefined || only.plan.kind !== 'row') {
        throw error;
      }
      const sqlError: PlannedFile<TParam> = {
        fileName: only.fileName,
        plan: {
          kind: 'invalid',
          checksum: only.plan.checksum,
          diagnostics: [
            {
              code: 'sql-error',
              table: state.model.schemaKey,
              file: relativePath(state, only.fileName),
              message: errorMessage(error),
            },
          ],
          unknownKeys: [],
        },
      };
      return commit(state, [sqlError]);
    }
    return items.flatMap((item) => {
      const recorded = record(state, item);
      return recorded === undefined ? [] : [recorded];
    });
  };

  const syncFile = async (
    state: TableState<TParam>,
    fileName: string,
  ): Promise<ChangeEvent | undefined> => {
    const [changed] = await commit(state, [{ fileName, plan: await planFile(state, fileName) }]);
    return changed;
  };

  const listFiles = async (state: TableState<TParam>): Promise<string[]> => {
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

  const syncTable = async (state: TableState<TParam>): Promise<ChangeEvent[]> => {
    const present = await listFiles(state);
    const planned: PlannedFile<TParam>[] = [...state.files.keys()]
      .filter((fileName) => !present.includes(fileName))
      .map((fileName) => ({ fileName, plan: { kind: 'remove' } }));
    for (const fileName of present) {
      planned.push({ fileName, plan: await planFile(state, fileName) });
    }
    return commit(state, planned);
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
