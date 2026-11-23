import { resolve } from 'node:path';
import { createSqlmdError, type Diagnostic, formatDiagnostic } from './errors.js';
import { schemaHash, type TableModel } from './model.js';
import { type ChangeEvent, createStore, type IndexBackend, type TableReport } from './store.js';
import { startWatcher, type Watcher, type WatchOptions } from './watcher.js';

export type InvalidFileMode = 'throw' | 'skip';

/** Options shared by every sqlmd entry point. */
export interface BaseOptions {
  /** Folder that holds one sub-folder per table. Relative paths resolve from the working directory. */
  readonly root: string;
  /**
   * What to do with files that fail validation on the first load. `throw` (default) rejects with
   * every diagnostic; `skip` leaves those files out and reports them. While watching, invalid files
   * are always skipped and reported, so a typo in one file never stops the dev server.
   */
  readonly onInvalid?: InvalidFileMode;
  /** Called for every diagnostic, on the first load and while watching. */
  readonly onDiagnostic?: (diagnostic: Diagnostic) => void;
  /** Start watching right away. Pass options to tune the watcher. */
  readonly watch?: boolean | WatchOptions;
  /** File extensions that count as rows. Defaults to `['.md']`. */
  readonly extensions?: readonly string[];
}

export interface IndexReport {
  /** Hash of the table structure. It changes when the schema or table options change. */
  readonly schemaHash: string;
  readonly tables: readonly TableReport[];
  readonly diagnostics: readonly Diagnostic[];
}

export type ChangeListener = (events: readonly ChangeEvent[]) => void;

/** The index lifecycle every sqlmd instance has, whatever its query surface. */
export interface SqlmdIndex {
  /** Current diagnostics for files that are left out of the index. */
  readonly diagnostics: () => readonly Diagnostic[];
  /** Row counts, skipped files and frontmatter keys that match no column, per table. */
  readonly report: () => IndexReport;
  /** Re-scans every folder. Unchanged files are skipped by checksum. */
  readonly reload: () => Promise<readonly ChangeEvent[]>;
  /** Starts watching the table folders. Calling it again does nothing. */
  readonly watch: (options?: WatchOptions) => void;
  /** Listens for batches of row changes from the watcher or `reload`. Returns an unsubscribe function. */
  readonly subscribe: (listener: ChangeListener) => () => void;
  /** Resolves once every queued file update has been applied. */
  readonly settled: () => Promise<void>;
  /** Stops watching and closes the in-memory database. */
  readonly close: () => Promise<void>;
}

export interface IndexHandle extends SqlmdIndex {
  readonly isClosed: () => boolean;
}

export interface OpenIndexOptions<TParam> {
  readonly options: BaseOptions;
  readonly models: readonly TableModel[];
  readonly backend: IndexBackend<TParam>;
  /** Closes the index database. Called by `close()` and when the first load fails. */
  readonly closeBackend: () => Promise<void>;
  /** Runs once after the first load, e.g. to build indexes over the loaded rows. */
  readonly afterLoad?: () => Promise<void>;
}

/**
 * Loads every table folder through `backend`, then returns the shared watcher, queue, change
 * listeners and lifecycle. The entry points add their query surface on top.
 */
export const openIndex = async <TParam>(open: OpenIndexOptions<TParam>): Promise<IndexHandle> => {
  const { options, models, backend, closeBackend, afterLoad } = open;
  const userDiagnostic = options.onDiagnostic ?? (() => undefined);
  const store = createStore({
    backend,
    models,
    root: resolve(options.root),
    extensions: options.extensions ?? ['.md'],
    onDiagnostic: (diagnostic) => userDiagnostic(diagnostic),
  });

  try {
    await store.syncAll();
    await afterLoad?.();
  } catch (error) {
    await closeBackend();
    throw error;
  }

  const initial = store.diagnostics();
  if ((options.onInvalid ?? 'throw') === 'throw' && initial.length > 0) {
    await closeBackend();
    throw createSqlmdError(
      'VALIDATION',
      `${initial.length} markdown file problem(s):\n${initial.map(formatDiagnostic).join('\n')}`,
      { diagnostics: initial },
    );
  }

  let closed = false;
  let queue: Promise<void> = Promise.resolve();
  let watcher: Watcher | undefined;
  const listeners = new Set<ChangeListener>();

  const emit = (events: readonly ChangeEvent[]) => {
    if (events.length === 0) {
      return;
    }
    for (const listener of listeners) {
      listener(events);
    }
  };

  const enqueue = (task: () => Promise<ChangeEvent[]>): Promise<readonly ChangeEvent[]> => {
    const next = queue.then(async () => {
      if (closed) {
        return [];
      }
      const events = await task();
      emit(events);
      return events;
    });
    queue = next.then(
      () => undefined,
      (error) => {
        userDiagnostic({
          code: 'watch-error',
          table: '',
          file: '',
          message: error instanceof Error ? error.message : String(error),
        });
      },
    );
    return next;
  };

  const watch = (watchOptions?: WatchOptions) => {
    if (watcher !== undefined || closed) {
      return;
    }
    watcher = startWatcher(
      {
        store,
        enqueue: (task) => {
          void enqueue(task);
        },
        onDiagnostic: userDiagnostic,
      },
      watchOptions,
    );
  };

  if (options.watch !== undefined && options.watch !== false) {
    watch(options.watch === true ? {} : options.watch);
  }

  return {
    isClosed: () => closed,
    diagnostics: () => store.diagnostics(),
    report: () => ({
      schemaHash: schemaHash(models),
      tables: store.report(),
      diagnostics: store.diagnostics(),
    }),
    reload: () => enqueue(() => store.syncAll()),
    watch,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    settled: () => queue,
    close: async () => {
      if (closed) {
        return;
      }
      watcher?.close();
      watcher = undefined;
      await queue;
      closed = true;
      listeners.clear();
      await closeBackend();
    },
  };
};
