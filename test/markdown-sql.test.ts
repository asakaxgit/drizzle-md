import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  findMarkdownSqlError,
  isMarkdownSqlError,
  type MarkdownSql,
  markdownSql,
} from '../src/index.js';
import { copyFixture, fixture, nextEvent } from './helpers.js';

describe('MarkdownSQL with inferred tables and columns', () => {
  let md: MarkdownSql;

  beforeAll(async () => {
    md = await markdownSql({ root: fixture('content') });
  });

  afterAll(async () => {
    await md.close();
  });

  it('finds one table per folder and infers columns from frontmatter', () => {
    expect(md.tables().map((table) => table.table)).toEqual(['authors', 'posts']);
    const posts = md.tables().find((table) => table.table === 'posts');
    expect(posts?.columns.map((column) => [column.name, column.type, column.role])).toEqual([
      ['id', 'text', 'key'],
      ['author', 'text', 'data'],
      ['draft', 'boolean', 'data'],
      ['layout', 'text', 'data'],
      ['meta', 'json', 'data'],
      ['published', 'text', 'data'],
      ['rating', 'real', 'data'],
      ['status', 'text', 'data'],
      ['tags', 'json', 'data'],
      ['title', 'text', 'data'],
      ['views', 'integer', 'data'],
      ['body', 'text', 'body'],
    ]);
  });

  it('returns rows as objects keyed by column name', async () => {
    const rows = await md.query('select id, title, views, draft from posts order by id');
    expect(rows).toEqual([
      { id: 'hello-world', title: 'Hello, world', views: 120, draft: null },
      { id: 'second-post', title: 'Second post', views: 30, draft: null },
      { id: 'work-in-progress', title: 'Work in progress', views: null, draft: 1 },
    ]);
  });

  it('binds template values as parameters, never as SQL', async () => {
    const minViews = 50;
    const rows = await md.sql`select id from posts where views > ${minViews}`;
    expect(rows).toEqual([{ id: 'hello-world' }]);
    const injected = "x' or 1=1 --";
    expect(await md.sql`select id from posts where id = ${injected}`).toEqual([]);
    expect(await md.sql`select id from posts where draft = ${true}`).toEqual([
      { id: 'work-in-progress' },
    ]);
  });

  it('stores lists and mappings as JSON and the body as text', async () => {
    const tags = await md.query(
      "select p.id, t.value as tag from posts p, json_each(p.tags) t where t.value = 'drizzle' order by p.id",
    );
    expect(tags).toEqual([
      { id: 'hello-world', tag: 'drizzle' },
      { id: 'second-post', tag: 'drizzle' },
    ]);
    const [row] = await md.query(
      "select meta ->> '$.readingTime' as minutes, body from posts where id = ?",
      ['second-post'],
    );
    expect(row).toEqual({ minutes: 3, body: 'More words.\n' });
  });

  it('joins tables', async () => {
    const rows = await md.query(
      'select a.name, count(*) as posts from posts p join authors a on a.id = p.author group by a.name order by a.name',
    );
    expect(rows).toEqual([
      { name: 'Ada Lovelace', posts: 2 },
      { name: 'Grace Hopper', posts: 1 },
    ]);
  });

  it('rejects writes as READ_ONLY', async () => {
    await expect(md.query("delete from posts where id = 'hello-world'")).rejects.toSatisfy(
      (error: Error) => isMarkdownSqlError(error, 'READ_ONLY'),
    );
    await expect(
      md.query("with gone as (select 1) delete from posts where id = 'hello-world'"),
    ).rejects.toSatisfy((error: Error) => isMarkdownSqlError(error, 'READ_ONLY'));
    expect(await md.query('select count(*) as n from posts')).toEqual([{ n: 3 }]);
  });

  it('reports the index like the Drizzle entry points', () => {
    const report = md.report();
    expect(report.schemaHash).toMatch(/^[0-9a-f]{64}$/);
    expect(report.tables.find((table) => table.table === 'posts')).toMatchObject({
      rows: 3,
      skipped: 0,
      unknownKeys: {},
    });
  });
});

describe('MarkdownSQL with declared tables', () => {
  it('uses declared columns, folders, keys and bodies', async () => {
    const md = await markdownSql({
      root: fixture('content'),
      tables: {
        articles: {
          dir: 'posts',
          key: 'slug',
          body: false,
          columns: {
            title: { type: 'text', required: true },
            published: 'date',
            views: 'integer',
            status: { type: 'text', values: ['idea', 'published'] },
          },
        },
      },
    });
    try {
      expect(md.tables()).toEqual([
        {
          table: 'articles',
          dir: 'posts',
          columns: [
            { name: 'slug', type: 'text', role: 'key', required: true },
            { name: 'title', type: 'text', role: 'data', required: true },
            { name: 'published', type: 'date', role: 'data', required: false },
            { name: 'views', type: 'integer', role: 'data', required: false },
            { name: 'status', type: 'text', role: 'data', required: false },
          ],
        },
      ]);
      expect(await md.query('select slug, published from articles order by slug')).toEqual([
        { slug: 'hello-world', published: '2026-11-01T00:00:00.000Z' },
        { slug: 'second-post', published: '2026-11-10T09:30:00.000Z' },
        { slug: 'work-in-progress', published: '2026-11-20T00:00:00.000Z' },
      ]);
      expect(md.report().tables[0]?.unknownKeys).toMatchObject({ author: 3, tags: 2 });
    } finally {
      await md.close();
    }
  });

  it('reports files that do not match declared columns', async () => {
    const md = await markdownSql({
      root: fixture('invalid'),
      onInvalid: 'skip',
      tables: { posts: { columns: { title: { type: 'text', required: true }, views: 'integer' } } },
    });
    try {
      expect(
        md
          .diagnostics()
          .map((d) => [d.file, d.code])
          .sort(),
      ).toEqual([
        ['posts/bad-views.md', 'type-mismatch'],
        ['posts/broken-yaml.md', 'invalid-frontmatter'],
        ['posts/missing-title.md', 'missing-required'],
      ]);
      expect(await md.query('select id from posts')).toEqual([{ id: 'ok' }]);
    } finally {
      await md.close();
    }
  });

  it('rejects invalid files on the first load by default', async () => {
    const error = await markdownSql({ root: fixture('invalid') }).catch((caught: Error) => caught);
    expect(findMarkdownSqlError(error)?.code).toBe('VALIDATION');
  });

  it('works with the node:sqlite driver', async () => {
    const md = await markdownSql({ root: fixture('content'), driver: 'node:sqlite' });
    try {
      expect(await md.sql`select name from authors where email is ${null}`).toEqual([
        { name: 'Grace Hopper' },
      ]);
      await expect(md.query('drop table authors')).rejects.toSatisfy((error: Error) =>
        isMarkdownSqlError(error, 'READ_ONLY'),
      );
    } finally {
      await md.close();
    }
  });
});

describe('MarkdownSQL lifecycle', () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it('applies file changes while watching', async () => {
    const copy = await copyFixture('content');
    cleanup = copy.cleanup;
    const md = await markdownSql({ root: copy.root, watch: { debounceMs: 20 } });
    try {
      const added = nextEvent(md, (event) => event.key === 'third');
      await writeFile(
        join(copy.root, 'posts', 'third.md'),
        '---\ntitle: Third\nauthor: grace\nviews: 7\n---\nNew.\n',
      );
      expect((await added).type).toBe('add');
      await md.settled();
      expect(await md.sql`select title, views from posts where id = ${'third'}`).toEqual([
        { title: 'Third', views: 7 },
      ]);
    } finally {
      await md.close();
    }
  });

  it('rejects queries after close()', async () => {
    const md = await markdownSql({ root: fixture('content') });
    await md.close();
    await md.close();
    await expect(md.query('select 1')).rejects.toSatisfy((error: Error) =>
      isMarkdownSqlError(error, 'CLOSED'),
    );
  });
});

describe('MarkdownSQL config', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'markdown-sql-core-'));
    await mkdir(join(root, 'notes'));
    await mkdir(join(root, '.git'));
    await mkdir(join(root, '_drafts'));
    await writeFile(join(root, 'notes', 'a.md'), '---\nn: 1\nempty: null\n---\n');
    await writeFile(join(root, 'notes', 'b.md'), '---\nn: 1.5\nempty: null\nmixed: 2\n---\n');
    await writeFile(join(root, 'notes', 'c.md'), '---\nmixed: two\n---\n');
    await writeFile(join(root, 'notes', 'skip.txt'), 'not a row');
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const configError = async (promise: Promise<MarkdownSql>): Promise<string | undefined> => {
    const error = await promise.then(
      () => undefined,
      (caught: Error) => caught,
    );
    return findMarkdownSqlError(error)?.code === 'CONFIG' ? error?.message : undefined;
  };

  it('skips folders starting with . or _ and widens mixed column types', async () => {
    const md = await markdownSql({ root });
    try {
      expect(md.tables().map((table) => table.table)).toEqual(['notes']);
      expect(md.tables()[0]?.columns.map((column) => [column.name, column.type])).toEqual([
        ['id', 'text'],
        ['empty', 'text'],
        ['mixed', 'text'],
        ['n', 'real'],
        ['body', 'text'],
      ]);
      expect(await md.query('select id, mixed from notes order by id')).toEqual([
        { id: 'a', mixed: null },
        { id: 'b', mixed: '2' },
        { id: 'c', mixed: 'two' },
      ]);
    } finally {
      await md.close();
    }
  });

  it('treats a declared table with a missing folder as empty', async () => {
    const md = await markdownSql({ root, tables: { missing: {} } });
    try {
      expect(await md.query('select count(*) as n from missing')).toEqual([{ n: 0 }]);
    } finally {
      await md.close();
    }
  });

  it('rejects bad configuration as CONFIG errors', async () => {
    expect(await configError(markdownSql({ root: join(root, 'nope') }))).toMatch(/Cannot read/);
    expect(await configError(markdownSql({ root: join(root, '_drafts') }))).toMatch(
      /no table folders/,
    );
    expect(await configError(markdownSql({ root, tables: {} }))).toMatch(/tables is empty/);
    expect(
      await configError(
        markdownSql({
          root,
          tables: { notes: { columns: { n: { type: 'text', values: ['a'] }, x: 'real' } } },
        }),
      ),
    ).toBeUndefined();
    expect(
      await configError(
        markdownSql({
          root,
          tables: { notes: { columns: { n: { type: 'real', values: ['a'] } } } },
        }),
      ),
    ).toMatch(/only allowed on text/);
    expect(
      await configError(
        // A JavaScript caller can pass any string; the type check is at runtime too.
        markdownSql({ root, tables: { notes: { columns: JSON.parse('{"n":"float"}') } } }),
      ),
    ).toMatch(/unknown type "float"/);
    expect(
      await configError(markdownSql({ root, tables: { notes: { key: 'x', body: 'x' } } })),
    ).toMatch(/cannot both be/);
    expect(
      await configError(markdownSql({ root, tables: { notes: { columns: { id: 'text' } } } })),
    ).toMatch(/already the key column/);
    expect(
      await configError(markdownSql({ root, tables: { notes: { columns: { body: 'text' } } } })),
    ).toMatch(/already the body column/);
  });
});
