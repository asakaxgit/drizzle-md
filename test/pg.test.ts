import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { arrayContains, count, desc, eq, sql } from 'drizzle-orm';
import {
  bigint,
  integer,
  pgEnum,
  pgSchema as pgNamespace,
  pgTable,
  smallint,
  text,
} from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DrizzleMdPg, drizzleMd, findSqlmdError, isSqlmdError } from '../src/pg/index.js';
import { copyFixture, fixture, nextEvent } from './helpers.js';
import { authors, pgSchema, posts } from './pg-schema.js';

const caught = <T>(promise: PromiseLike<T>): Promise<Error | undefined> =>
  Promise.resolve(promise).then(
    () => undefined,
    (error: Error) => error,
  );

describe('sqlmd/pg loading', () => {
  let md: DrizzleMdPg<typeof pgSchema>;

  beforeAll(async () => {
    md = await drizzleMd({ root: fixture('content'), schema: pgSchema });
  });

  afterAll(async () => {
    await md.close();
  });

  it('loads one row per file, keyed by file name', async () => {
    const rows = await md.db.select({ id: posts.id }).from(posts).orderBy(posts.id);
    expect(rows.map((row) => row.id)).toEqual(['hello-world', 'second-post', 'work-in-progress']);
  });

  it('maps lists to text[], mappings to jsonb, and coerces dates, enums and numbers', async () => {
    const [hello] = await md.db.select().from(posts).where(eq(posts.id, 'hello-world'));
    expect(hello).toMatchObject({
      id: 'hello-world',
      title: 'Hello, world',
      author: 'ada',
      published: new Date('2026-11-01T00:00:00Z'),
      draft: false,
      views: 120,
      rating: 4.5,
      tags: ['intro', 'drizzle'],
      meta: null,
      status: 'published',
      body: '# Hello\n\nThe first post.\n',
    });
    const [second] = await md.db.select().from(posts).where(eq(posts.id, 'second-post'));
    expect(second?.published).toEqual(new Date('2026-11-10T09:30:00Z'));
    expect(second?.meta).toEqual({ readingTime: 3 });
  });

  it('fills .default(), SQL defaults and defaultNow()', async () => {
    const [draft] = await md.db.select().from(posts).where(eq(posts.id, 'work-in-progress'));
    expect(draft).toMatchObject({ draft: true, views: 0, tags: [], rating: null, status: null });
    expect(draft?.indexedAt).toBeInstanceOf(Date);
    expect(Math.abs(Date.now() - (draft?.indexedAt.getTime() ?? 0))).toBeLessThan(60_000);
  });

  it('queries arrays and jsonb with Postgres operators', async () => {
    const tagged = await md.db
      .select({ id: posts.id })
      .from(posts)
      .where(arrayContains(posts.tags, ['drizzle']))
      .orderBy(posts.id);
    expect(tagged.map((row) => row.id)).toEqual(['hello-world', 'second-post']);
    const long = await md.db
      .select({ id: posts.id })
      .from(posts)
      .where(sql`(${posts.meta}->>'readingTime')::int >= 3`);
    expect(long).toEqual([{ id: 'second-post' }]);
  });

  it('joins, aggregates and runs relational queries', async () => {
    const joined = await md.db
      .select({ author: authors.name, posts: count() })
      .from(posts)
      .innerJoin(authors, eq(posts.author, authors.id))
      .groupBy(authors.name)
      .orderBy(desc(count()));
    expect(joined).toEqual([
      { author: 'Ada Lovelace', posts: 2 },
      { author: 'Grace Hopper', posts: 1 },
    ]);
    const nested = await md.db.query.authors.findMany({
      columns: { id: true },
      with: { posts: { columns: { id: true }, orderBy: posts.id } },
      orderBy: authors.id,
    });
    expect(nested).toEqual([
      { id: 'ada', posts: [{ id: 'hello-world' }, { id: 'work-in-progress' }] },
      { id: 'grace', posts: [{ id: 'second-post' }] },
    ]);
  });

  it('runs raw SQL through execute()', async () => {
    const rows = await md.db.execute(sql`select count(*)::int as n from ${posts}`);
    expect(rows).toEqual([{ n: 3 }]);
  });

  it('reports rows and unknown keys like the SQLite entry point', () => {
    const report = md.report();
    expect(report.tables.find((table) => table.table === 'posts')).toMatchObject({
      rows: 3,
      skipped: 0,
      unknownKeys: { layout: 1 },
    });
    expect(md.diagnostics()).toEqual([]);
  });
});

describe('sqlmd/pg read-only', () => {
  let md: DrizzleMdPg<typeof pgSchema>;

  beforeAll(async () => {
    md = await drizzleMd({ root: fixture('content'), schema: pgSchema, prepopulated: false });
  });

  afterAll(async () => {
    await md.close();
  });

  const expectReadOnly = async (query: PromiseLike<object>) => {
    const error = await caught(query);
    expect(isSqlmdError(error, 'READ_ONLY')).toBe(true);
    expect(findSqlmdError(error)?.message).toContain('read-only');
  };

  it('rejects inserts, updates and deletes', async () => {
    await expectReadOnly(
      md.db.insert(posts).values({
        id: 'new',
        title: 'New',
        author: 'ada',
        published: new Date(),
        body: '',
      }),
    );
    await expectReadOnly(
      md.db.update(posts).set({ title: 'Changed' }).where(eq(posts.id, 'hello-world')),
    );
    await expectReadOnly(md.db.delete(posts));
  });

  it('rejects writes inside WITH and DO blocks, DDL and role changes', async () => {
    await expectReadOnly(
      md.db.execute(sql`with gone as (delete from posts returning id) select * from gone`),
    );
    await expectReadOnly(md.db.execute(sql`do $$ begin delete from posts; end $$`));
    await expectReadOnly(md.db.execute(sql`/* sneaky */ drop table posts`));
    await expectReadOnly(md.db.execute(sql`set default_transaction_read_only = off`));
    await expectReadOnly(md.db.execute(sql`reset role`));
    await expectReadOnly(
      md.db.execute(sql`select set_config('transaction_read_only', 'off', false)`),
    );
    await expectReadOnly(md.db.execute(sql`explain analyze delete from posts`));
  });

  it('rolls back every statement, so settings never outlive a query', async () => {
    await md.db.execute(sql`select set_config('role', 'postgres', false)`);
    const rows = await md.db.execute(sql`select current_user as role`);
    expect(rows).toEqual([{ role: 'md_reader' }]);
    const [counted] = await md.db.select({ n: count() }).from(posts);
    expect(counted?.n).toBe(3);
  });

  it('rejects queries and live queries after close()', async () => {
    const closing = await drizzleMd({ root: fixture('content'), schema: pgSchema });
    await closing.close();
    await closing.close();
    const error = await caught(closing.db.select().from(posts));
    expect(isSqlmdError(error, 'CLOSED')).toBe(true);
    const liveError = await caught(closing.live(closing.db.select().from(posts), () => undefined));
    expect(isSqlmdError(liveError, 'CLOSED')).toBe(true);
  });
});

describe('sqlmd/pg watcher and live queries', () => {
  it('applies file changes and re-runs live queries', async () => {
    const { root, cleanup } = await copyFixture('content');
    const md = await drizzleMd({
      root,
      schema: pgSchema,
      watch: { debounceMs: 10, persistent: false },
    });
    try {
      const results: string[][] = [];
      const errors: Error[] = [];
      let notify = () => undefined;
      const subscription = await md.live(
        md.db.select({ id: posts.id }).from(posts).where(eq(posts.draft, false)).orderBy(posts.id),
        (rows) => {
          results.push(rows.map((row) => row.id));
          notify();
        },
        (error) => errors.push(error),
      );
      const waitFor = (ids: readonly string[]) =>
        new Promise<void>((resolve) => {
          const check = () => {
            if (results.some((ids2) => ids2.join() === ids.join())) {
              resolve();
              return undefined;
            }
            return undefined;
          };
          notify = check;
          check();
        });
      await waitFor(['hello-world', 'second-post']);

      const added = nextEvent(md, (event) => event.key === 'third');
      await writeFile(
        join(root, 'posts', 'third.md'),
        '---\ntitle: Third\nauthor: grace\npublished: 2026-11-22\ntags: [new]\n---\nHi\n',
      );
      expect(await added).toMatchObject({ type: 'add', table: 'posts' });
      await waitFor(['hello-world', 'second-post', 'third']);

      const [third] = await md.db.select().from(posts).where(eq(posts.id, 'third'));
      expect(third).toMatchObject({ title: 'Third', tags: ['new'], draft: false });

      const invalid = nextEvent(md, (event) => event.key === 'third');
      await writeFile(join(root, 'posts', 'third.md'), '---\ntitle: [broken\n---\n');
      expect(await invalid).toMatchObject({ type: 'invalid' });
      await waitFor(['hello-world', 'second-post']);
      expect(errors).toEqual([]);

      await subscription.unsubscribe();
      await subscription.unsubscribe();
    } finally {
      await md.close();
      await cleanup();
    }
  });

  it('rejects live queries that write', async () => {
    const md = await drizzleMd({ root: fixture('content'), schema: pgSchema });
    try {
      const error = await caught(md.live(md.db.delete(posts).returning(), () => undefined));
      expect(isSqlmdError(error, 'READ_ONLY')).toBe(true);
    } finally {
      await md.close();
    }
  });

  it('unsubscribes live queries on close()', async () => {
    const md = await drizzleMd({ root: fixture('content'), schema: pgSchema });
    const seen: number[] = [];
    await md.live(md.db.select().from(posts), (rows) => seen.push(rows.length));
    await md.close();
    expect(seen).toEqual([3]);
  });
});

describe('sqlmd/pg loading paths and setup', () => {
  it('falls back to one file at a time when COPY rejects a row', async () => {
    const { root, cleanup } = await copyFixture('content');
    try {
      await writeFile(
        join(root, 'posts', 'too-long.md'),
        `---\ntitle: ${'x'.repeat(60)}\nauthor: ada\npublished: 2026-11-01\n---\n`,
      );
      const md = await drizzleMd({ root, schema: pgSchema, onInvalid: 'skip' });
      try {
        expect(md.diagnostics()).toEqual([
          expect.objectContaining({ code: 'sql-error', file: 'posts/too-long.md' }),
        ]);
        const rows = await md.db.select({ id: posts.id }).from(posts);
        expect(rows).toHaveLength(3);
      } finally {
        await md.close();
      }
    } finally {
      await cleanup();
    }
  });

  it('rejects invalid files on the first load by default', async () => {
    const error = await caught(drizzleMd({ root: fixture('invalid'), schema: pgSchema }));
    expect(isSqlmdError(error, 'VALIDATION')).toBe(true);
  });

  it('runs setup SQL with PGlite extensions, e.g. pg_trgm and GIN indexes', async () => {
    const md = await drizzleMd({
      root: fixture('content'),
      schema: pgSchema,
      prepopulated: true,
      pglite: { extensions: { pg_trgm } },
      setup: `CREATE EXTENSION pg_trgm;
        CREATE INDEX posts_tags_idx ON posts USING gin (tags);
        CREATE INDEX posts_title_trgm_idx ON posts USING gin (title gin_trgm_ops)`,
    });
    try {
      const rows = await md.db
        .select({ id: posts.id })
        .from(posts)
        .where(sql`${posts.title} % 'Helo wrld'`);
      expect(rows).toEqual([{ id: 'hello-world' }]);
    } finally {
      await md.close();
    }
  });

  it('closes PGlite when the setup SQL fails', async () => {
    const error = await caught(
      drizzleMd({ root: fixture('content'), schema: pgSchema, setup: 'not sql' }),
    );
    expect(error?.message).toContain('syntax error');
  });

  it('accepts integer keys, enum arrays and bigint values', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sqlmd-pg-'));
    try {
      await mkdir(join(root, 'numbered'));
      await writeFile(
        join(root, 'numbered', '7.md'),
        "---\nlabels: [a, b]\nbig: '9007199254740993'\n---\nseven\n",
      );
      await writeFile(join(root, 'numbered', '8.md'), '---\nlabels: [a, z]\n---\n');
      await writeFile(join(root, 'numbered', '9.md'), '---\nlabels: [a, null]\n---\n');
      await writeFile(join(root, 'numbered', 'ten.md'), '---\n---\n');
      const md = await drizzleMd({ root, schema: { label, numbered }, onInvalid: 'skip' });
      try {
        const rows = await md.db.select().from(numbered).orderBy(numbered.id);
        expect(rows).toEqual([
          { id: 7, labels: ['a', 'b'], big: 9007199254740993n, scores: [], body: 'seven\n' },
        ]);
        expect(md.diagnostics().map((diagnostic) => [diagnostic.file, diagnostic.code])).toEqual([
          ['numbered/8.md', 'type-mismatch'],
          ['numbered/9.md', 'type-mismatch'],
          ['numbered/ten.md', 'invalid-key'],
        ]);
      } finally {
        await md.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

const label = pgEnum('label', ['a', 'b']);

const numbered = pgTable('numbered', {
  id: smallint().primaryKey(),
  labels: label().array(),
  big: bigint({ mode: 'bigint' }),
  scores: integer().array().notNull().default([]),
  body: text(),
});

describe('sqlmd/pg config', () => {
  it('needs Postgres tables', async () => {
    const error = await caught(drizzleMd({ root: fixture('content'), schema: {} }));
    expect(isSqlmdError(error, 'CONFIG')).toBe(true);
    expect(error?.message).toContain('no Drizzle Postgres tables');
  });

  it('rejects tables and enums outside the default schema', async () => {
    const content = pgNamespace('content');
    const scoped = content.table('posts', { id: text().primaryKey() });
    const tableError = await caught(drizzleMd({ root: fixture('content'), schema: { scoped } }));
    expect(isSqlmdError(tableError, 'CONFIG')).toBe(true);
    const mood = content.enum('mood', ['happy']);
    const moods = pgTable('moods', { id: text().primaryKey(), mood: mood() });
    const enumError = await caught(drizzleMd({ root: fixture('content'), schema: { moods } }));
    expect(isSqlmdError(enumError, 'CONFIG')).toBe(true);
  });
});
