import { count, desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DrizzleMd, drizzleMd } from '../src/index.js';
import { fixture } from './helpers.js';
import { authors, posts, schema } from './schema.js';

describe.each(['better-sqlite3', 'node:sqlite'] as const)('loading with %s', (driver) => {
  let md: DrizzleMd<typeof schema>;

  beforeAll(async () => {
    md = await drizzleMd({ root: fixture('content'), schema, driver });
  });

  afterAll(async () => {
    await md.close();
  });

  it('loads one row per file, keyed by file name', async () => {
    const rows = await md.db.select({ id: posts.id }).from(posts).orderBy(posts.id);
    expect(rows.map((row) => row.id)).toEqual(['hello-world', 'second-post', 'work-in-progress']);
  });

  it('coerces frontmatter to column types', async () => {
    const hello = await md.db.select().from(posts).where(eq(posts.id, 'hello-world')).get();
    expect(hello).toEqual({
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
    const second = await md.db.select().from(posts).where(eq(posts.id, 'second-post')).get();
    expect(second?.published).toEqual(new Date('2026-11-10T09:30:00Z'));
    expect(second?.meta).toEqual({ readingTime: 3 });
  });

  it('fills defaults for missing columns', async () => {
    const draft = await md.db.select().from(posts).where(eq(posts.id, 'work-in-progress')).get();
    expect(draft).toMatchObject({ draft: true, views: 0, tags: [], rating: null, status: null });
  });

  it('returns undefined from get() when nothing matches', async () => {
    expect(await md.db.select().from(posts).where(eq(posts.id, 'missing')).get()).toBeUndefined();
  });

  it('joins tables', async () => {
    const rows = await md.db
      .select({ post: posts.id, author: authors.name, authorId: authors.id })
      .from(posts)
      .innerJoin(authors, eq(posts.author, authors.id))
      .where(eq(posts.draft, false))
      .orderBy(posts.id);
    expect(rows).toEqual([
      { post: 'hello-world', author: 'Ada Lovelace', authorId: 'ada' },
      { post: 'second-post', author: 'Grace Hopper', authorId: 'grace' },
    ]);
  });

  it('runs aggregates and raw SQL', async () => {
    const perAuthor = await md.db
      .select({ author: posts.author, posts: count() })
      .from(posts)
      .groupBy(posts.author)
      .orderBy(posts.author);
    expect(perAuthor).toEqual([
      { author: 'ada', posts: 2 },
      { author: 'grace', posts: 1 },
    ]);
    const [total] = await md.db.all<[number]>(sql`select sum(${posts.views}) from ${posts}`);
    expect(total).toEqual([150]);
    const tagged = await md.db
      .select({ id: posts.id })
      .from(posts)
      .where(sql`exists (select 1 from json_each(${posts.tags}) where value = 'intro')`);
    expect(tagged).toEqual([{ id: 'hello-world' }]);
  });

  it('supports relational queries', async () => {
    const ada = await md.db.query.authors.findFirst({
      where: eq(authors.id, 'ada'),
      with: { posts: { columns: { id: true }, orderBy: desc(posts.published) } },
    });
    expect(ada?.posts).toEqual([{ id: 'work-in-progress' }, { id: 'hello-world' }]);
    const post = await md.db.query.posts.findFirst({
      where: eq(posts.id, 'second-post'),
      with: { writer: { columns: { name: true } } },
    });
    expect(post?.writer).toEqual({ name: 'Grace Hopper' });
  });

  it('reports row counts and unknown frontmatter keys', () => {
    const report = md.report();
    expect(report.schemaHash).toMatch(/^[0-9a-f]{64}$/);
    expect(report.tables).toEqual([
      { table: 'authors', dir: 'authors', rows: 2, skipped: 0, unknownKeys: {} },
      { table: 'posts', dir: 'posts', rows: 3, skipped: 0, unknownKeys: { layout: 1 } },
    ]);
    expect(report.diagnostics).toEqual([]);
  });
});
