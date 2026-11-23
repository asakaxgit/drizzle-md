# drizzle-md

Query folders of markdown files with [Drizzle ORM](https://orm.drizzle.team). Each folder is a table, each `.md` file is a row, YAML frontmatter holds the columns and the markdown body is one more column.

drizzle-md reads the files into an in-memory SQLite database and gives you a normal Drizzle database over it, so `select`, `where`, joins, aggregates, raw SQL and relational queries (`db.query`) all work as usual. An optional file watcher keeps the index in sync while you edit.

- Define tables with Drizzle's own `sqliteTable`. No new schema language.
- Typed columns: text, integer, real, boolean, timestamp, JSON, enums and bigint.
- Joins across folders, e.g. posts and their authors.
- File watcher with checksums and debouncing, so only changed files are re-read.
- No framework dependency.
- Optional Postgres entry point, `drizzle-md/pg`, backed by [PGlite](https://pglite.dev): `pgTable` schemas, `text[]` and `jsonb` columns, Postgres operators and extensions, and live queries.

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

## Postgres with PGlite (`drizzle-md/pg`)

`drizzle-md/pg` builds the same index in [PGlite](https://pglite.dev), Postgres compiled to WebAssembly, so you can write `pgTable` schemas and use Postgres features: array operators, `jsonb`, full-text search, `pg_trgm` and GIN indexes. The watcher, diagnostics, `report()`, `reload()`, `subscribe()`, `settled()` and `close()` behave exactly as in the SQLite entry point.

```bash
npm install drizzle-md drizzle-orm @electric-sql/pglite
# optional, for faster startup:
npm install @electric-sql/pglite-prepopulatedfs
```

```typescript
import { arrayContains, eq } from 'drizzle-orm';
import { boolean, jsonb, pgEnum, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { drizzleMd } from 'drizzle-md/pg';

export const status = pgEnum('status', ['idea', 'published']);

export const posts = pgTable('posts', {
  id: text().primaryKey(),
  title: text().notNull(),
  published: timestamp({ withTimezone: true }).notNull(),
  draft: boolean().notNull().default(false),
  tags: text().array().notNull().default([]), // a YAML list
  meta: jsonb().$type<{ readingTime: number }>(), // a YAML mapping
  status: status(),
  body: text().notNull(),
});

const md = await drizzleMd({ root: 'content', schema: { status, posts }, watch: true });

const tagged = await md.db
  .select()
  .from(posts)
  .where(arrayContains(posts.tags, ['drizzle']));

// Re-runs whenever a file in posts/ changes; rows are typed and mapped by Drizzle.
const live = await md.live(
  md.db.select({ id: posts.id }).from(posts).where(eq(posts.draft, false)),
  (rows) => console.log(rows),
);
await live.unsubscribe();
await md.close();
```

YAML lists fill array columns (`text().array()`, enum arrays, `integer().array()`, each item checked against the element type), and mappings or lists fill `json()` / `jsonb()` columns. `pgEnum` types are created for you. On the first load each folder is bulk-loaded with one `COPY … FROM '/dev/blob'`; if Postgres rejects a row (say a `varchar(40)` overflow), drizzle-md retries file by file and reports only that file as a `sql-error`.

Options on top of the SQLite ones:

| Option | Meaning |
| --- | --- |
| `prepopulated` | Start from the `@electric-sql/pglite-prepopulatedfs` snapshot instead of running initdb (about 0.5 s instead of 1.4 s). Default: use it when it is installed. `true` requires it, `false` skips it. Its version must match `@electric-sql/pglite`. |
| `pglite` | Extra PGlite options, such as `extensions: { pg_trgm }` or `debug`. The data directory is always in memory. |
| `setup` | SQL run once as the database owner after the tables are created and before the files load, e.g. `CREATE EXTENSION pg_trgm; CREATE INDEX ON posts USING gin (tags)`. |

```typescript
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

const md = await drizzleMd({
  root: 'content',
  schema: { posts },
  pglite: { extensions: { pg_trgm } },
  setup: `CREATE EXTENSION pg_trgm;
    CREATE INDEX posts_title_trgm ON posts USING gin (title gin_trgm_ops);`,
});
```

**Read-only.** Every statement from `md.db` runs in its own `READ ONLY` transaction, as a select-only `md_reader` role, and is always rolled back. Writes, DDL, `DO` blocks, `SET` and writes hidden in `WITH` are rejected with the same `READ_ONLY` error code as the SQLite entry point. `md.live()` first runs the query through that read-only path before PGlite's live extension sees it.

**Trade-offs.** Pick `drizzle-md/pg` when you want Postgres features or already use Postgres schemas; the SQLite entry point stays the lighter default.

| | SQLite (`drizzle-md`) | PGlite (`drizzle-md/pg`) |
| --- | --- | --- |
| Memory | a few MB | about 570–700 MB RSS per instance (WebAssembly heap) |
| Startup | milliseconds | about 0.5 s with the snapshot, 1.4 s without |
| Per-query overhead | microseconds | about 0.2 ms (transaction, role switch, rollback) |
| Runtimes | Node.js | Node.js; not Cloudflare Workers (PGlite needs more memory and WebAssembly than Workers allow) |
| Extras | | arrays, `jsonb`, enums, extensions, GIN indexes, live queries |

## Limitations

- Read-only in version 1: edit the markdown files to change data.
- One folder per table and one level deep: files in sub-folders are not read.
- Generated columns, `blob({ mode: 'buffer' })` columns and unique or foreign key constraints are not applied to the index. Foreign keys still work in joins and relations.
- The index lives in memory and is rebuilt on every start.
- The watcher doesn't notice a table folder that is created after `watch()` starts.
- `drizzle-md/pg`: only tables and enums in the default `public` schema; indexes and constraints declared in `pgTable` are not created (use `setup`); generated columns are not supported yet.

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
