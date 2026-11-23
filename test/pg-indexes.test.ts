import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { sql } from 'drizzle-orm';
import { boolean, index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drizzleMd, isDrizzleMdError } from '../src/pg/index.js';
import { indexDdl } from '../src/pg/indexes.js';
import { pgDialect } from '../src/pg/schema.js';
import { buildModels } from '../src/schema.js';

const docs = pgTable(
  'docs',
  {
    id: text().primaryKey(),
    title: text().notNull(),
    slug: text().notNull(),
    tags: text().array().notNull().default([]),
    draft: boolean().notNull().default(false),
    published: timestamp({ withTimezone: true }),
    body: text(),
  },
  (t) => [
    uniqueIndex('docs_slug_key').on(t.slug),
    index('docs_tags_gin').using('gin', t.tags),
    index('docs_published_idx').on(t.published.desc().nullsLast(), t.id),
    index('docs_title_lower_idx').on(sql`lower(${t.title})`),
    index('docs_live_idx').on(t.published).where(sql`${t.draft} = false`),
    index('docs_title_trgm').using('gin', t.title.op('gin_trgm_ops')),
    index().on(t.title).with({ fillfactor: 70 }).concurrently(),
  ],
);

const doc = (title: string, slug: string, extra = '') =>
  `---\ntitle: ${title}\nslug: ${slug}\ntags: [a]\npublished: 2026-11-01\n${extra}---\nBody\n`;

const withDocs = async (files: Readonly<Record<string, string>>) => {
  const root = await mkdtemp(join(tmpdir(), 'drizzle-md-idx-'));
  await mkdir(join(root, 'docs'));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(root, 'docs', name), content);
  }
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
};

const caught = <T>(promise: PromiseLike<T>): Promise<Error | undefined> =>
  Promise.resolve(promise).then(
    () => undefined,
    (error: Error) => error,
  );

describe('indexDdl', () => {
  it('renders columns, methods, operator classes, order, expressions, WHERE and WITH', () => {
    const statements = indexDdl(buildModels({ docs }, {}, pgDialect));
    expect(statements.map((statement) => [statement.unique, statement.sql])).toEqual([
      [true, 'CREATE UNIQUE INDEX "docs_slug_key" ON "docs" ("slug")'],
      [false, 'CREATE INDEX "docs_tags_gin" ON "docs" USING gin ("tags")'],
      [false, 'CREATE INDEX "docs_published_idx" ON "docs" ("published" DESC NULLS LAST, "id")'],
      [false, 'CREATE INDEX "docs_title_lower_idx" ON "docs" ((lower("title")))'],
      [false, 'CREATE INDEX "docs_live_idx" ON "docs" ("published") WHERE "draft" = false'],
      [false, 'CREATE INDEX "docs_title_trgm" ON "docs" USING gin ("title" gin_trgm_ops)'],
      [false, 'CREATE INDEX ON "docs" ("title") WITH (fillfactor = 70)'],
    ]);
  });

  it('rejects bound values in index expressions and unsupported WITH values', () => {
    const bound = pgTable('bound', { id: text().primaryKey(), status: text() }, (t) => [
      index('bound_idx').on(t.status).where(sql`${t.status} = ${'published'}`),
    ]);
    expect(() => indexDdl(buildModels({ bound }, {}, pgDialect))).toThrow(/bound values/);
    const odd = pgTable('odd', { id: text().primaryKey() }, (t) => [
      index('odd_idx')
        .on(t.id)
        .with({ fillfactor: [70] }),
    ]);
    expect(() => indexDdl(buildModels({ odd }, {}, pgDialect))).toThrow(/WITH option "fillfactor"/);
    const quoted = pgTable('quoted', { id: text().primaryKey() }, (t) => [
      index('quoted_idx').on(t.id).with({ note: "it's", fast: true }),
    ]);
    expect(indexDdl(buildModels({ quoted }, {}, pgDialect))[0]?.sql).toBe(
      `CREATE INDEX "quoted_idx" ON "quoted" ("id") WITH (note = 'it''s', fast = true)`,
    );
  });
});

describe('drizzle-md/pg indexes', () => {
  let md: Awaited<ReturnType<typeof drizzleMd<{ docs: typeof docs }>>>;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const created = await withDocs({
      'one.md': doc('First', 'first'),
      'two.md': doc('Second', 'second', 'draft: true\n'),
      'dupe.md': doc('Copy', 'first'),
    });
    cleanup = created.cleanup;
    md = await drizzleMd({
      root: created.root,
      schema: { docs },
      onInvalid: 'skip',
      pglite: { extensions: { pg_trgm } },
      setup: 'CREATE EXTENSION pg_trgm',
    });
  });

  afterAll(async () => {
    await md.close();
    await cleanup();
  });

  it('creates every declared index', async () => {
    const rows = await md.db.execute(
      sql`select indexname from pg_indexes where tablename = 'docs' order by indexname`,
    );
    expect(rows.map((row) => row.indexname)).toEqual([
      'docs_live_idx',
      'docs_pkey',
      'docs_published_idx',
      'docs_slug_key',
      'docs_tags_gin',
      'docs_title_idx',
      'docs_title_lower_idx',
      'docs_title_trgm',
    ]);
  });

  it('enforces unique indexes per file', async () => {
    expect(md.diagnostics()).toEqual([
      expect.objectContaining({
        code: 'sql-error',
        file: 'docs/one.md',
        message: expect.stringContaining('docs_slug_key'),
      }),
    ]);
    const rows = await md.db.select({ id: docs.id }).from(docs).orderBy(docs.id);
    // Files load in name order, so dupe.md claims the slug first.
    expect(rows).toEqual([{ id: 'dupe' }, { id: 'two' }]);
  });

  it('answers queries that use the indexes', async () => {
    const rows = await md.db.select({ id: docs.id }).from(docs).where(sql`${docs.title} % 'Secnd'`);
    expect(rows).toEqual([{ id: 'two' }]);
  });
});

describe('drizzle-md/pg index errors', () => {
  it('reports an index Postgres cannot build as a CONFIG error', async () => {
    const broken = pgTable('docs', { id: text().primaryKey(), title: text() }, (t) => [
      index('docs_trgm').using('gin', t.title.op('gin_trgm_ops')),
    ]);
    const { root, cleanup } = await withDocs({ 'one.md': '---\ntitle: One\n---\n' });
    try {
      const error = await caught(
        drizzleMd({ root, schema: { broken }, tables: { broken: { dir: 'docs' } } }),
      );
      expect(isDrizzleMdError(error, 'CONFIG')).toBe(true);
      expect(error?.message).toContain('index "docs_trgm" could not be created');
    } finally {
      await cleanup();
    }
  });
});
