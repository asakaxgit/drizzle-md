import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DrizzleMd, drizzleMd, findDrizzleMdError, isDrizzleMdError } from '../src/index.js';
import { fixture } from './helpers.js';
import { posts, schema } from './schema.js';

describe.each(['better-sqlite3', 'node:sqlite'] as const)('read-only with %s', (driver) => {
  let md: DrizzleMd<typeof schema>;

  beforeAll(async () => {
    md = await drizzleMd({ root: fixture('content'), schema, driver });
  });

  afterAll(async () => {
    await md.close();
  });

  const expectReadOnly = async (query: Promise<object>) => {
    const error = await query.then(
      () => undefined,
      (caught: Error) => caught,
    );
    expect(isDrizzleMdError(error, 'READ_ONLY')).toBe(true);
    expect(findDrizzleMdError(error)?.message).toContain('read-only');
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

  it('rejects DDL, pragmas and writes hidden behind WITH', async () => {
    await expectReadOnly(md.db.run(sql`drop table posts`));
    await expectReadOnly(md.db.run(sql`pragma query_only = off`));
    await expectReadOnly(md.db.run(sql`with gone as (select 1) delete from posts`));
    await expectReadOnly(md.db.run(sql`/* sneaky */ insert into posts (id) values ('x')`));
  });

  it('still answers reads afterwards', async () => {
    const rows = await md.db.select({ id: posts.id }).from(posts);
    expect(rows).toHaveLength(3);
    const explained = await md.db.all(sql`explain query plan select * from posts`);
    expect(explained.length).toBeGreaterThan(0);
  });
});

describe('closed instance', () => {
  it('rejects queries after close()', async () => {
    const md = await drizzleMd({ root: fixture('content'), schema });
    await md.close();
    await md.close();
    const error = await md.db
      .select()
      .from(posts)
      .then(
        () => undefined,
        (caught: Error) => caught,
      );
    expect(isDrizzleMdError(error, 'CLOSED')).toBe(true);
    expect(isDrizzleMdError(new Error('other'))).toBe(false);
  });
});
