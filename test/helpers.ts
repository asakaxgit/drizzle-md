import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChangeEvent, DrizzleMd } from '../src/index.js';

export const fixture = (name: string): string => join(import.meta.dirname, 'fixtures', name);

/** Copies a fixture folder to a fresh temp folder, so a test can change files freely. */
export const copyFixture = async (
  name: string,
): Promise<{ root: string; cleanup: () => Promise<void> }> => {
  const root = await mkdtemp(join(tmpdir(), 'drizzle-md-'));
  await cp(fixture(name), root, { recursive: true });
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
};

/** Resolves with the first change event that matches, or rejects after `timeoutMs`. */
export const nextEvent = <TSchema extends Record<string, object>>(
  md: DrizzleMd<TSchema>,
  matches: (event: ChangeEvent) => boolean,
  timeoutMs = 5000,
): Promise<ChangeEvent> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error('timed out waiting for a change event'));
    }, timeoutMs);
    const unsubscribe = md.subscribe((events) => {
      const found = events.find(matches);
      if (found !== undefined) {
        clearTimeout(timer);
        unsubscribe();
        resolve(found);
      }
    });
  });
