import { describe, expect, it, vi } from 'vitest';
import type { Diagnostic } from '../src/drizzle/index.js';
import { drizzleMd, isMarkdownSqlError } from '../src/pg/index.js';
import { chooseSnapshot, PGLITE, PREPOPULATED, type SnapshotSource } from '../src/pg/snapshot.js';
import { fixture } from './helpers.js';
import { pgSchema, posts } from './pg-schema.js';

// Pretend the installed snapshot package is a different version from PGlite.
vi.mock('../src/pg/versions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/pg/versions.js')>();
  return {
    packageVersion: async (name: string) =>
      name === '@electric-sql/pglite-prepopulatedfs' ? '0.0.1' : actual.packageVersion(name),
  };
});

const caught = <T>(promise: PromiseLike<T>): Promise<Error | undefined> =>
  Promise.resolve(promise).then(
    () => undefined,
    (error: Error) => error,
  );

const snapshotBlob = new Blob(['snapshot']);

const source = (versions: Readonly<Record<string, string>>, load?: () => Promise<Blob>) =>
  ({
    version: async (name) => versions[name],
    load: load ?? (async () => snapshotBlob),
  }) satisfies SnapshotSource;

describe('chooseSnapshot', () => {
  const matching = { [PGLITE]: '0.5.17', [PREPOPULATED]: '0.5.17' };
  const mismatched = { [PGLITE]: '0.5.17', [PREPOPULATED]: '0.5.16' };

  it('uses the snapshot when the versions match', async () => {
    expect(await chooseSnapshot(undefined, source(matching))).toEqual({ dataDir: snapshotBlob });
    expect(await chooseSnapshot(true, source(matching))).toEqual({ dataDir: snapshotBlob });
  });

  it('never uses it with prepopulated: false', async () => {
    expect(await chooseSnapshot(false, source(matching))).toEqual({ dataDir: undefined });
  });

  it('starts normally without a warning when the package is not installed', async () => {
    expect(await chooseSnapshot(undefined, source({ [PGLITE]: '0.5.17' }))).toEqual({
      dataDir: undefined,
    });
    const error = await caught(chooseSnapshot(true, source({ [PGLITE]: '0.5.17' })));
    expect(isMarkdownSqlError(error, 'CONFIG')).toBe(true);
    expect(error?.message).toContain('is not installed');
  });

  it('falls back with a warning on a version mismatch, and fails when required', async () => {
    const choice = await chooseSnapshot(undefined, source(mismatched));
    expect(choice.dataDir).toBeUndefined();
    expect(choice.warning).toContain('0.5.16 does not match @electric-sql/pglite 0.5.17');
    const error = await caught(chooseSnapshot(true, source(mismatched)));
    expect(isMarkdownSqlError(error, 'CONFIG')).toBe(true);
    expect(error?.message).toContain('does not match');
  });

  it('treats a missing PGlite version as a mismatch', async () => {
    const choice = await chooseSnapshot(undefined, source({ [PREPOPULATED]: '0.5.17' }));
    expect(choice.warning).toContain('(not found)');
  });

  it('falls back with a warning when loading fails, and fails when required', async () => {
    const broken = source(matching, async () => {
      throw new Error('corrupt archive');
    });
    const choice = await chooseSnapshot(undefined, broken);
    expect(choice).toEqual({
      dataDir: undefined,
      warning: expect.stringContaining('corrupt archive'),
    });
    const error = await caught(chooseSnapshot(true, broken));
    expect(isMarkdownSqlError(error, 'CONFIG')).toBe(true);
    expect(error?.cause).toBeInstanceOf(Error);
  });
});

describe('packageVersion', () => {
  it('finds installed versions and returns undefined for missing packages', async () => {
    const { packageVersion } =
      await vi.importActual<typeof import('../src/pg/versions.js')>('../src/pg/versions.js');
    const pglite = await packageVersion(PGLITE);
    expect(pglite).toMatch(/^\d+\.\d+\.\d+/);
    expect(await packageVersion(PREPOPULATED)).toBe(pglite);
    expect(await packageVersion('markdown-sql-no-such-package')).toBeUndefined();
  });
});

describe('markdown-sql/pg with a mismatched snapshot package', () => {
  // PGlite's cold start without a snapshot can exceed Vitest's 5 s default under CI load.
  it('starts without the snapshot and reports a startup-warning', async () => {
    const diagnostics: Diagnostic[] = [];
    const md = await drizzleMd({
      root: fixture('content'),
      schema: pgSchema,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    try {
      expect(diagnostics).toEqual([
        expect.objectContaining({
          code: 'startup-warning',
          message: expect.stringContaining('0.0.1 does not match'),
        }),
      ]);
      expect(md.diagnostics()).toEqual([]);
      expect(await md.db.select({ id: posts.id }).from(posts)).toHaveLength(3);
    } finally {
      await md.close();
    }
  }, 20_000);

  it('fails with prepopulated: true', async () => {
    const error = await caught(
      drizzleMd({ root: fixture('content'), schema: pgSchema, prepopulated: true }),
    );
    expect(isMarkdownSqlError(error, 'CONFIG')).toBe(true);
  });
});
