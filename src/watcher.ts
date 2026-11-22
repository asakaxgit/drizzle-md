import { type FSWatcher, watch } from 'node:fs';
import type { Diagnostic } from './errors.js';
import type { ChangeEvent, Store, TableState } from './store.js';

export interface WatchOptions {
  /** Wait this long after the last event for a file before reading it. Defaults to 50 ms. */
  readonly debounceMs?: number;
  /** Keep the process alive while watching. Defaults to true. */
  readonly persistent?: boolean;
}

export interface Watcher {
  readonly close: () => void;
}

export interface WatcherContext {
  readonly store: Store;
  readonly enqueue: (task: () => Promise<ChangeEvent[]>) => void;
  readonly onDiagnostic: (diagnostic: Diagnostic) => void;
}

const WHOLE_TABLE = Symbol('whole table');

/**
 * Watches each table folder with fs.watch. Events are debounced per file, then the file is
 * re-read; its checksum decides whether anything changed. When the platform does not report a
 * file name, the whole folder is re-scanned.
 */
export const startWatcher = (context: WatcherContext, options: WatchOptions = {}): Watcher => {
  const { store, enqueue, onDiagnostic } = context;
  const debounceMs = options.debounceMs ?? 50;
  const timers = new Map<string, NodeJS.Timeout>();
  const watchers: FSWatcher[] = [];

  const schedule = (state: TableState, fileName: string | typeof WHOLE_TABLE) => {
    const timerKey = `${state.model.schemaKey}\0${typeof fileName === 'string' ? fileName : '*'}`;
    clearTimeout(timers.get(timerKey));
    const timer = setTimeout(() => {
      timers.delete(timerKey);
      enqueue(async () => {
        if (typeof fileName !== 'string') {
          return store.syncTable(state);
        }
        const changed = await store.syncFile(state, fileName);
        return changed === undefined ? [] : [changed];
      });
    }, debounceMs);
    if (options.persistent === false) {
      timer.unref();
    }
    timers.set(timerKey, timer);
  };

  for (const state of store.tables) {
    try {
      const watcher = watch(
        state.absoluteDir,
        { persistent: options.persistent ?? true },
        (_, fileName) => {
          if (fileName === null) {
            schedule(state, WHOLE_TABLE);
          } else if (store.isRowFile(fileName)) {
            schedule(state, fileName);
          }
        },
      );
      watcher.on('error', (error) => {
        onDiagnostic({
          code: 'watch-error',
          table: state.model.schemaKey,
          file: state.model.dir,
          message: error.message,
        });
      });
      watchers.push(watcher);
    } catch (error) {
      onDiagnostic({
        code: 'watch-error',
        table: state.model.schemaKey,
        file: state.model.dir,
        message: `cannot watch folder: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  return {
    close: () => {
      for (const watcher of watchers) {
        watcher.close();
      }
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
    },
  };
};
