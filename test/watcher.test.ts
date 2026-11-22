import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Diagnostic, type DrizzleMd, drizzleMd } from '../src/index.js';
import { copyFixture, nextEvent } from './helpers.js';
import { posts, schema } from './schema.js';

const post = (title: string, extra = '') =>
  `---\ntitle: ${title}\nauthor: ada\npublished: 2026-11-23\n${extra}---\n\nBody of ${title}.\n`;

describe('watcher', () => {
  let root: string;
  let cleanup: () => Promise<void>;
  let md: DrizzleMd<typeof schema>;
  let diagnostics: Diagnostic[];

  beforeEach(async () => {
    ({ root, cleanup } = await copyFixture('content'));
    diagnostics = [];
    md = await drizzleMd({
      root,
      schema,
      watch: { debounceMs: 20, persistent: false },
      onDiagnostic: (d) => diagnostics.push(d),
    });
  });

  afterEach(async () => {
    await md.close();
    await cleanup();
  });

  const titleOf = async (id: string) =>
    (await md.db.select({ title: posts.title }).from(posts).where(eq(posts.id, id)).get())?.title;

  it('adds a row when a file is created', async () => {
    const added = nextEvent(md, (e) => e.key === 'new-post');
    await writeFile(join(root, 'posts/new-post.md'), post('New post'));
    expect(await added).toMatchObject({ type: 'add', table: 'posts', file: 'posts/new-post.md' });
    expect(await titleOf('new-post')).toBe('New post');
  });

  it('updates a row when a file changes', async () => {
    const changed = nextEvent(md, (e) => e.key === 'hello-world');
    await writeFile(join(root, 'posts/hello-world.md'), post('Hello again'));
    expect(await changed).toMatchObject({ type: 'change' });
    expect(await titleOf('hello-world')).toBe('Hello again');
  });

  it('removes a row when a file is deleted', async () => {
    const removed = nextEvent(md, (e) => e.key === 'second-post');
    await rm(join(root, 'posts/second-post.md'));
    expect(await removed).toMatchObject({ type: 'unlink', file: 'posts/second-post.md' });
    expect(await titleOf('second-post')).toBeUndefined();
  });

  it('handles an atomic save (write to a temp file, then rename)', async () => {
    const changed = nextEvent(md, (e) => e.key === 'hello-world');
    const temp = join(root, 'posts/.hello-world.md.tmp');
    await writeFile(temp, post('Saved atomically'));
    await rename(temp, join(root, 'posts/hello-world.md'));
    expect(await changed).toMatchObject({ type: 'change' });
    expect(await titleOf('hello-world')).toBe('Saved atomically');
  });

  it('drops a row that becomes invalid, and restores it once fixed', async () => {
    const invalid = nextEvent(md, (e) => e.key === 'hello-world');
    await writeFile(
      join(root, 'posts/hello-world.md'),
      '---\nauthor: ada\npublished: 2026-11-23\n---\n',
    );
    const event = await invalid;
    expect(event.type).toBe('invalid');
    expect(event.diagnostics).toMatchObject([{ code: 'missing-required', column: 'title' }]);
    expect(diagnostics).toHaveLength(1);
    expect(await titleOf('hello-world')).toBeUndefined();
    expect(md.report().tables.find((t) => t.table === 'posts')).toMatchObject({
      rows: 2,
      skipped: 1,
    });

    const fixed = nextEvent(md, (e) => e.key === 'hello-world');
    await writeFile(join(root, 'posts/hello-world.md'), post('Fixed'));
    expect(await fixed).toMatchObject({ type: 'add', diagnostics: [] });
    expect(md.diagnostics()).toEqual([]);
    expect(await titleOf('hello-world')).toBe('Fixed');
  });

  it('skips files whose content did not change', async () => {
    const events: string[] = [];
    md.subscribe((batch) => events.push(...batch.map((e) => `${e.type}:${e.key}`)));
    const same = await readFile(join(root, 'posts/hello-world.md'), 'utf8');
    await writeFile(join(root, 'posts/hello-world.md'), same);
    const marker = nextEvent(md, (e) => e.key === 'marker');
    await writeFile(join(root, 'posts/marker.md'), post('Marker'));
    await marker;
    expect(events).toEqual(['add:marker']);
  });

  it('ignores editor swap and backup files', async () => {
    const events: string[] = [];
    md.subscribe((batch) => events.push(...batch.map((e) => e.file)));
    await writeFile(join(root, 'posts/.hello-world.md.swp'), 'swap');
    await writeFile(join(root, 'posts/hello-world.md~'), 'backup');
    await writeFile(join(root, 'posts/#hello-world.md#'), 'emacs');
    const marker = nextEvent(md, (e) => e.key === 'marker');
    await writeFile(join(root, 'posts/marker.md'), post('Marker'));
    await marker;
    expect(events).toEqual(['posts/marker.md']);
  });

  it('debounces bursts of writes into one update', async () => {
    const events: string[] = [];
    md.subscribe((batch) => events.push(...batch.map((e) => `${e.type}:${e.key}`)));
    const settledOnLast = nextEvent(md, (e) => e.key === 'burst');
    for (const n of [1, 2, 3, 4, 5]) {
      await writeFile(join(root, 'posts/burst.md'), post(`Burst ${n}`));
    }
    await settledOnLast;
    await new Promise((resolve) => setTimeout(resolve, 100));
    await md.settled();
    expect(await titleOf('burst')).toBe('Burst 5');
    expect(events.filter((e) => e.endsWith(':burst')).length).toBeLessThanOrEqual(2);
  });

  it('stops after close()', async () => {
    await md.close();
    await writeFile(join(root, 'posts/after-close.md'), post('Late'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(diagnostics).toEqual([]);
  });
});

describe('reload and watch()', () => {
  it('re-scans on reload() and starts watching on demand', async () => {
    const { root, cleanup } = await copyFixture('content');
    const md = await drizzleMd({ root, schema });
    await writeFile(join(root, 'posts/manual.md'), post('Manual'));
    await rm(join(root, 'posts/second-post.md'));
    const events = await md.reload();
    expect(events.map((e) => `${e.type}:${e.key}`).sort()).toEqual([
      'add:manual',
      'unlink:second-post',
    ]);
    expect(await md.reload()).toEqual([]);

    md.watch({ debounceMs: 10, persistent: false });
    md.watch();
    const added = nextEvent(md, (e) => e.key === 'watched');
    await writeFile(join(root, 'posts/watched.md'), post('Watched'));
    expect(await added).toMatchObject({ type: 'add' });
    await md.close();
    await cleanup();
  });
});
