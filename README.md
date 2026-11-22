# drizzle-md

Query folders of markdown files with [Drizzle ORM](https://orm.drizzle.team). Each folder is a table, each `.md` file is a row, YAML frontmatter holds the columns and the markdown body is one more column.

drizzle-md reads the files into an in-memory SQLite database and gives you a normal Drizzle database over it, so `select`, `where`, joins, aggregates, raw SQL and relational queries (`db.query`) all work as usual. An optional file watcher keeps the index in sync while you edit.

- Define tables with Drizzle's own `sqliteTable`. No new schema language.
- Typed columns: text, integer, real, boolean, timestamp, JSON, enums and bigint.
- Joins across folders, e.g. posts and their authors.
- File watcher with checksums and debouncing, so only changed files are re-read.
- No framework dependency.

> **Status:** version 1 is read-only and not published to npm yet. Writes and file migrations are on the [roadmap](#roadmap).

## Install

```bash
npm install drizzle-md drizzle-orm
```

Node.js 22 or later. The default SQLite driver is [better-sqlite3](https://github.com/WiseLibs/better-sqlite3), which installs a prebuilt binary. Node's built-in `node:sqlite` works too (`driver: 'node:sqlite'`, Node.js 22.16 or later).

## Quick start

```text
content/
├── authors/
│   ├── ada.md
│   └── grace.md
└── posts/
    ├── hello-world.md
    └── second-post.md
```

`content/posts/hello-world.md`:

```markdown
---
title: Hello, world
author: ada
published: 2026-11-01
tags: [intro, drizzle]
---

# Hello

The first post.
```

```typescript
import { eq, relations } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { drizzleMd } from 'drizzle-md';

export const authors = sqliteTable('authors', {
  id: text().primaryKey(), // file name without .md
  name: text().notNull(),
  body: text().notNull(), // markdown body
});

export const posts = sqliteTable('posts', {
  id: text().primaryKey(),
  title: text().notNull(),
  author: text().notNull(),
  published: integer({ mode: 'timestamp' }).notNull(), // ISO date in frontmatter
  draft: integer({ mode: 'boolean' }).notNull().default(false),
  tags: text({ mode: 'json' }).$type<string[]>().notNull().$defaultFn(() => []),
  body: text().notNull(),
});

export const postsRelations = relations(posts, ({ one }) => ({
  writer: one(authors, { fields: [posts.author], references: [authors.id] }),
}));

const md = await drizzleMd({
  root: 'content',
  schema: { authors, posts, postsRelations },
});

// Plain Drizzle: posts joined with their authors.
const feed = await md.db
  .select({ title: posts.title, author: authors.name, published: posts.published })
  .from(posts)
  .innerJoin(authors, eq(posts.author, authors.id))
  .where(eq(posts.draft, false));

// Relational queries work too.
const post = await md.db.query.posts.findFirst({
  where: eq(posts.id, 'hello-world'),
  with: { writer: true },
});

await md.close();
```

## How files map to rows

| File part | Column |
| --- | --- |
| File name without the extension | The key column, `id` by default. Integer keys are parsed from names like `1.md`. |
| Each frontmatter key | The column with the same **property name** in the Drizzle table (`author`, not the SQL name). |
| Markdown body | The `body` column, if the table has one. |

Folder names default to the SQL table name. Override per table:

```typescript
await drizzleMd({
  root: 'content',
  schema: { notes },
  tables: {
    notes: { dir: 'my-notes', key: 'slug', body: 'content' }, // body: false skips the body
  },
});
```

Frontmatter is parsed with the YAML 1.2 core schema, and values are coerced to the column type:

| Column | Frontmatter |
| --- | --- |
| `text()` | strings; numbers and booleans become strings; `enum` values are checked |
| `integer()`, `real()` | numbers; `integer()` must be a whole number |
| `integer({ mode: 'boolean' })` | `true` / `false` |
| `integer({ mode: 'timestamp' \| 'timestamp_ms' })` | ISO 8601 dates, such as `2026-11-23` or `2026-11-23T09:00:00+09:00` |
| `text({ mode: 'json' })`, `blob({ mode: 'json' })` | any YAML value, including nested lists and mappings |
| `blob({ mode: 'bigint' })` | whole numbers or digit strings |

Missing keys get the column's default (`.default()`, `.$defaultFn()`, or a SQL default). Frontmatter keys that match no column are ignored and counted in `md.report()`, so you can spot schema drift. A frontmatter key named like the key or body column is ignored too: the file name and the body win.

## Invalid files

A file is invalid when its YAML is broken, a `notNull` column without a default is missing, or a value doesn't fit its column. By default the first load throws an error listing every problem:

```typescript
import { drizzleMd, findDrizzleMdError } from 'drizzle-md';

try {
  await drizzleMd({ root: 'content', schema });
} catch (error) {
  for (const d of findDrizzleMdError(error)?.diagnostics ?? []) {
    console.error(`${d.file}: ${d.message}`); // posts/bad.md: expected a number, got string "many"
  }
}
```

With `onInvalid: 'skip'` invalid files are left out and reported instead:

```typescript
const md = await drizzleMd({
  root: 'content',
  schema,
  onInvalid: 'skip',
  onDiagnostic: (d) => console.warn(`${d.file}: ${d.message}`),
});
md.diagnostics(); // current problems
md.report(); // { schemaHash, tables: [{ table, dir, rows, skipped, unknownKeys }], diagnostics }
```

## Watching for changes

```typescript
const md = await drizzleMd({ root: 'content', schema, watch: true });
// or later: md.watch({ debounceMs: 50 });

const unsubscribe = md.subscribe((events) => {
  for (const event of events) {
    console.log(event.type, event.table, event.key); // 'add' | 'change' | 'unlink' | 'invalid'
  }
});

// ...
unsubscribe();
await md.close();
```

The watcher uses `fs.watch` on each table folder. Events are debounced per file, each file is hashed so saves without changes are skipped, and editor files (dotfiles such as `.post.md.swp`, `*~`, `#post.md#`, `*.tmp`) are ignored. Atomic saves (write a temp file, then rename) work. While watching, invalid files are always skipped and reported, so one typo doesn't stop your dev server; the row comes back once the file is fixed. `md.reload()` re-scans everything by hand.

## Read-only

Version 1 doesn't write files. Any `insert`, `update`, `delete`, DDL or `PRAGMA` sent through `md.db` is rejected with a `DrizzleMdError` whose `code` is `READ_ONLY`. Drizzle wraps it in its own `DrizzleQueryError`, so check with `isDrizzleMdError(error, 'READ_ONLY')` or `findDrizzleMdError(error)`.

## Limitations

- Read-only in version 1: edit the markdown files to change data.
- One folder per table and one level deep: files in sub-folders are not read.
- Generated columns, `blob({ mode: 'buffer' })` columns and unique or foreign key constraints are not applied to the index. Foreign keys still work in joins and relations.
- The index lives in memory and is rebuilt on every start.
- The watcher doesn't notice a table folder that is created after `watch()` starts.

## Roadmap

- **Writes:** `insert`, `update` and `delete` through Drizzle that create, rewrite or remove the matching files, keeping unknown frontmatter keys and key order so git diffs stay small.
- **File migrations:** a drizzle-kit style diff between two schemas that renames, adds and drops frontmatter keys in the files.
- **Index cache:** keep the index on disk and rebuild only when the schema hash or files change.
- Nested folders and per-table glob patterns.

See [docs/design.md](docs/design.md) for the architecture and the migrations plan.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the setup, the coding conventions and the lint rules.

## License

[Apache-2.0](LICENSE)
