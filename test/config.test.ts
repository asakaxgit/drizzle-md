import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { blob, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { afterEach, describe, expect, it } from 'vitest';
import { type Diagnostic, drizzleMd, findMdqlError } from '../src/drizzle/index.js';

const roots: string[] = [];

/** Writes `files` (path relative to a fresh temp root → content) and returns the root. */
const tree = async (files: Readonly<Record<string, string>>): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'mdql-config-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const configError = async (run: () => Promise<object>): Promise<string | undefined> => {
  const error = await run().then(
    () => undefined,
    (caught: Error) => caught,
  );
  const found = findMdqlError(error);
  expect(found?.code).toBe('CONFIG');
  return found?.message;
};

describe('table options', () => {
  it('uses a custom folder, key column and body column', async () => {
    const notes = sqliteTable('notes', {
      slug: text().primaryKey(),
      title: text().notNull(),
      content: text().notNull(),
    });
    const root = await tree({ 'my-notes/first.md': '---\ntitle: First\n---\nHello' });
    const md = await drizzleMd({
      root,
      schema: { notes },
      tables: { notes: { dir: 'my-notes', key: 'slug', body: 'content' } },
    });
    expect(await md.db.select().from(notes)).toEqual([
      { slug: 'first', title: 'First', content: 'Hello' },
    ]);
    await md.close();
  });

  it('can leave the body out and use other extensions', async () => {
    const pages = sqliteTable('pages', { id: text().primaryKey(), body: text() });
    const root = await tree({
      'pages/a.markdown': 'A',
      'pages/b.md': 'B',
      'pages/.hidden.md': 'H',
    });
    const md = await drizzleMd({
      root,
      schema: { pages },
      tables: { pages: { body: false } },
      extensions: ['.markdown'],
    });
    expect(await md.db.select().from(pages)).toEqual([{ id: 'a', body: null }]);
    await md.close();
  });

  it('parses integer keys from file names and reports bad ones', async () => {
    const chapters = sqliteTable('chapters', {
      id: integer().primaryKey(),
      title: text().notNull(),
    });
    const root = await tree({
      'chapters/1.md': '---\ntitle: One\n---\n',
      'chapters/2.md': '---\ntitle: Two\n---\n',
      'chapters/intro.md': '---\ntitle: Intro\n---\n',
    });
    const md = await drizzleMd({ root, schema: { chapters }, onInvalid: 'skip' });
    expect(await md.db.select().from(chapters).orderBy(chapters.id)).toEqual([
      { id: 1, title: 'One' },
      { id: 2, title: 'Two' },
    ]);
    expect(md.diagnostics()).toMatchObject([{ code: 'invalid-key', file: 'chapters/intro.md' }]);
    await md.close();
  });

  it('evaluates SQL defaults', async () => {
    const items = sqliteTable('items', {
      id: text().primaryKey(),
      label: text().notNull().default(sql`('item-' || 7)`),
      score: real().$defaultFn(() => sql`(1.5 * 2)`),
    });
    const root = await tree({ 'items/a.md': '' });
    const md = await drizzleMd({ root, schema: { items } });
    expect(await md.db.select().from(items)).toEqual([{ id: 'a', label: 'item-7', score: 3 }]);
    await md.close();
  });

  it('accepts a composite primary key', async () => {
    const pairs = sqliteTable(
      'pairs',
      { id: text().notNull(), lang: text().notNull().default('en') },
      (table) => [primaryKey({ columns: [table.id, table.lang] })],
    );
    const root = await tree({ 'pairs/x.md': '---\nlang: ja\n---\n' });
    const md = await drizzleMd({ root, schema: { pairs } });
    expect(await md.db.select().from(pairs)).toEqual([{ id: 'x', lang: 'ja' }]);
    await md.close();
  });
});

describe('type coercion', () => {
  const things = sqliteTable('things', {
    id: text().primaryKey(),
    name: text(),
    count: integer(),
    ratio: real(),
    big: blob({ mode: 'bigint' }),
    flag: integer({ mode: 'boolean' }),
    at: integer({ mode: 'timestamp_ms' }),
    kind: text({ enum: ['a', 'b'] }),
    data: text({ mode: 'json' }),
    raw: blob({ mode: 'buffer' }),
  });

  const load = async (frontmatter: string) => {
    const root = await tree({ 'things/t.md': `---\n${frontmatter}\n---\n` });
    const diagnostics: Diagnostic[] = [];
    const md = await drizzleMd({
      root,
      schema: { things },
      onInvalid: 'skip',
      onDiagnostic: (d) => diagnostics.push(d),
    });
    const rows = await md.db.select().from(things);
    await md.close();
    return { row: rows[0], diagnostics };
  };

  it('converts valid values', async () => {
    const { row, diagnostics } = await load(
      [
        'name: 42',
        'count: 3',
        'ratio: 0.25',
        'big: "9007199254740993"',
        'flag: true',
        'at: 2026-11-23T02:00:00.123+09:00',
        'kind: b',
        'data: { nested: [1, { deep: true }] }',
      ].join('\n'),
    );
    expect(diagnostics).toEqual([]);
    expect(row).toEqual({
      id: 't',
      name: '42',
      count: 3,
      ratio: 0.25,
      big: 9007199254740993n,
      flag: true,
      at: new Date('2026-11-22T17:00:00.123Z'),
      kind: 'b',
      data: { nested: [1, { deep: true }] },
      raw: null,
    });
  });

  it('keeps explicit nulls in nullable columns and accepts numeric bigints', async () => {
    const { row } = await load('name: null\nbig: 12');
    expect(row).toMatchObject({ name: null, big: 12n });
  });

  it.each([
    ['name: { a: 1 }', 'name', 'expected text, got a mapping'],
    ['name: [1]', 'name', 'expected text, got a list'],
    ['count: 1.5', 'count', 'expected an integer, got 1.5'],
    ['ratio: "high"', 'ratio', 'expected a number'],
    ['big: 1.5', 'big', 'expected an integer'],
    ['flag: "yes"', 'flag', 'expected true or false'],
    ['at: tomorrow', 'at', 'expected an ISO 8601 date'],
    ['at: 2026-02-31T99:00', 'at', 'invalid date'],
    ['kind: c', 'kind', 'expected one of "a", "b"'],
    ['raw: abc', 'raw', 'cannot be read from frontmatter'],
  ])('reports %s', async (frontmatter, column, message) => {
    const { row, diagnostics } = await load(frontmatter);
    expect(row).toBeUndefined();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ code: 'type-mismatch', column, file: 'things/t.md' });
    expect(diagnostics[0]?.message).toContain(message);
  });
});

describe('configuration errors', () => {
  it('needs a key column', async () => {
    const noId = sqliteTable('no_id', { slug: text() });
    const root = await tree({});
    expect(await configError(() => drizzleMd({ root, schema: { noId } }))).toContain(
      'no column "id"',
    );
  });

  it('checks the body option', async () => {
    const pages = sqliteTable('pages', { id: text().primaryKey() });
    const root = await tree({});
    expect(
      await configError(() =>
        drizzleMd({ root, schema: { pages }, tables: { pages: { body: 'content' } } }),
      ),
    ).toContain('no column "content"');
  });

  it('rejects generated columns, empty schemas and duplicate table names', async () => {
    const root = await tree({});
    const generated = sqliteTable('gen', {
      id: text().primaryKey(),
      upper: text().generatedAlwaysAs(sql`upper(id)`),
    });
    expect(await configError(() => drizzleMd({ root, schema: { generated } }))).toContain(
      'generated column',
    );
    expect(await configError(() => drizzleMd({ root, schema: { nothing: {} } }))).toContain(
      'no Drizzle SQLite tables',
    );
    const a = sqliteTable('same', { id: text().primaryKey() });
    const b = sqliteTable('same', { id: text().primaryKey() });
    expect(await configError(() => drizzleMd({ root, schema: { a, b } }))).toContain('"same"');
  });
});
