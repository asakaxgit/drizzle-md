import { describe, expect, it } from 'vitest';
import { type Diagnostic, drizzleMd, findDrizzleMdError, formatDiagnostic } from '../src/index.js';
import { fixture } from './helpers.js';
import { posts, schema } from './schema.js';

const byFile = (a: Diagnostic, b: Diagnostic) => a.file.localeCompare(b.file);

describe('validation', () => {
  it('throws with every diagnostic by default', async () => {
    const error = await drizzleMd({ root: fixture('invalid'), schema }).then(
      () => undefined,
      (caught: Error) => caught,
    );
    const found = findDrizzleMdError(error);
    expect(found?.code).toBe('VALIDATION');
    expect(found?.message).toContain('3 markdown file problem(s)');
    expect(found?.diagnostics.map((d) => [d.file, d.code, d.column]).sort()).toEqual([
      ['posts/bad-views.md', 'type-mismatch', 'views'],
      ['posts/broken-yaml.md', 'invalid-frontmatter', undefined],
      ['posts/missing-title.md', 'missing-required', 'title'],
    ]);
  });

  it('skips invalid files and reports them in skip mode', async () => {
    const reported: Diagnostic[] = [];
    const md = await drizzleMd({
      root: fixture('invalid'),
      schema,
      onInvalid: 'skip',
      onDiagnostic: (diagnostic) => reported.push(diagnostic),
    });
    const rows = await md.db.select({ id: posts.id }).from(posts);
    expect(rows).toEqual([{ id: 'ok' }]);
    expect(reported.sort(byFile)).toEqual([...md.diagnostics()].sort(byFile));
    expect(reported).toHaveLength(3);
    const tableReport = md.report().tables.find((table) => table.table === 'posts');
    expect(tableReport).toMatchObject({ rows: 1, skipped: 3 });
    const views = reported.find((d) => d.column === 'views');
    expect(views === undefined ? '' : formatDiagnostic(views)).toBe(
      'posts/bad-views.md (views): expected a number, got string "many"',
    );
    await md.close();
  });

  it('treats a missing table folder as an empty table', async () => {
    const md = await drizzleMd({ root: fixture('invalid'), schema, onInvalid: 'skip' });
    expect(md.report().tables.find((table) => table.table === 'authors')).toMatchObject({
      rows: 0,
    });
    await md.close();
  });
});
