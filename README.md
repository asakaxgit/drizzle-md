# sqlmd

Query folders of markdown files with SQL. Each folder is a table, each `.md` file is a row, YAML frontmatter holds the columns, the file name is the key and the markdown body is one more column.

sqlmd reads the files into an in-memory SQLite database and gives you read-only SQL over it: no ORM, no schema file, no build step. An optional file watcher keeps the index in sync while you edit.

- **Zero config:** every sub-folder is a table and its columns are inferred from the frontmatter, or declare them with a few type names.
- Full SQLite `SELECT`: joins across folders, aggregates, window functions and `json_each` over YAML lists.
- File watcher with checksums and debouncing, so only changed files are re-read.
- Optional [Drizzle ORM](https://orm.drizzle.team) adapters: `sqlmd/drizzle` (SQLite) and `sqlmd/pg` ([PGlite](https://pglite.dev), Postgres in WebAssembly, with arrays, `jsonb`, extensions, indexes and live queries).
- No framework dependency. The main entry point never loads Drizzle or PGlite.

> **Status:** version 1 is read-only. Writes and file migrations are on the [roadmap](#roadmap). sqlmd was published as `drizzle-md` before; see [Migrating from drizzle-md](#migrating-from-drizzle-md).

## Install

```bash
npm install sqlmd
```

Node.js 22 or later. The default SQLite driver is [better-sqlite3](https://github.com/WiseLibs/better-sqlite3), which installs a prebuilt binary. Node's built-in `node:sqlite` works too (`driver: 'node:sqlite'`, Node.js 22.16 or later). `drizzle-orm` and PGlite are optional peer dependencies, needed only for `sqlmd/drizzle` and `sqlmd/pg`.

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
views: 120
tags: [intro, sql]
---

# Hello

The first post.
```

```typescript
import { sqlmd } from 'sqlmd';

const md = await sqlmd({ root: 'content' });

// Template values are bound as parameters, never pasted into the SQL.
const popular = await md.sql`
  select p.title, a.name as author
  from posts p join authors a on a.id = p.author
  where p.views > ${100}
  order by p.published desc`;

// Or a string with ? placeholders.
const tagged = await md.query(
  'select p.id from posts p, json_each(p.tags) t where t.value = ?',
  ['sql'],
);

md.tables(); // [{ table: 'authors', dir: 'authors', columns: [...] }, { table: 'posts', ... }]
await md.close();
```

Rows are plain objects keyed by result column name, with SQLite values: text, numbers, `bigint`, `null` or bytes.

## Tables and columns

| File part | Column |
| --- | --- |
| Folder under `root` | A table with the folder's name. Folders starting with `.` or `_` are skipped. |
| File name without the extension | The key column, `id` (TEXT primary key). |
| Each frontmatter key | A column with the same name. |
| Markdown body | The `body` column. |

Frontmatter is parsed with the YAML 1.2 core schema. Without `columns`, each table's column types are inferred from all of its files on the first load:

| Values seen for a key | Column type | Stored as |
| --- | --- | --- |
| only `true` / `false` | `boolean` | INTEGER `1` / `0` |
| only whole numbers | `integer` | INTEGER |
| numbers, some with decimals | `real` | REAL |
| only strings (dates included), or mixed scalars | `text` | TEXT |
| any list or mapping | `json` | TEXT holding JSON, for SQLite's `json_*` functions |
| only `null` | `text` | TEXT |

Inferred columns are never required. Dates stay text exactly as written; declare a `date` column to normalize them.

Declare tables to pick the folders, rename the key or body column, or fix the column types:

```typescript
const md = await sqlmd({
  root: 'content',
  tables: {
    articles: {
      dir: 'posts', // folder under root, defaults to the table name
      key: 'slug', // column for the file name, defaults to 'id'
      body: 'content', // column for the body, defaults to 'body'; false skips it
      columns: {
        title: { type: 'text', required: true },
        published: 'date', // ISO 8601 in frontmatter, stored as 2026-11-01T00:00:00.000Z
        views: 'integer',
        status: { type: 'text', values: ['idea', 'published'] },
        tags: 'json',
      },
    },
  },
});
```

With `tables`, only the listed tables are loaded; a table without `columns` still infers them. Declared columns are checked like the Drizzle ones: a value that doesn't fit (say `views: many`) or a missing required key makes the file invalid. Frontmatter keys that match no declared column are ignored and counted in `md.report()`.

| Member | Meaning |
| --- | --- |
| `query(sql, params?)` | Runs one read-only statement with `?` parameters; resolves to the rows. Booleans bind as `1` / `0`. |
| ``sql`…` `` | Tagged-template form of `query`. |
| `tables()` | Tables, folders and columns (name, type, role, required), including inferred ones. |
| `diagnostics()`, `report()`, `reload()`, `watch()`, `subscribe()`, `settled()`, `close()` | The shared index lifecycle, described below. |

## Drizzle ORM (`sqlmd/drizzle`)

`sqlmd/drizzle` gives you a normal, read-only Drizzle database over the same index, so you define tables with Drizzle's own `sqliteTable` and get typed `select`, `where`, joins, aggregates, raw SQL and relational queries (`db.query`).

```bash
npm install sqlmd drizzle-orm
```

```typescript
import { eq, relations } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { drizzleMd } from 'sqlmd/drizzle';

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

### How files map to Drizzle columns

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

Values are coerced to the Drizzle column type:

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

This works the same in every entry point. A file is invalid when its YAML is broken, a required column (`required: true`, or `notNull` without a default in Drizzle) is missing, or a value doesn't fit its column. By default the first load throws an error listing every problem:

```typescript
import { drizzleMd, findSqlmdError } from 'sqlmd/drizzle';

try {
  await drizzleMd({ root: 'content', schema });
} catch (error) {
  for (const d of findSqlmdError(error)?.diagnostics ?? []) {
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

The watcher is shared by every entry point.

```typescript
const md = await sqlmd({ root: 'content', watch: true });
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

Version 1 doesn't write files. `md.query()` and `md.sql` accept only `SELECT`, `WITH`, `VALUES` and `EXPLAIN`, and SQLite's `query_only` mode backs that up, so writes hidden in `WITH` fail too. Any `insert`, `update`, `delete`, DDL or `PRAGMA` sent through `md.db` in `sqlmd/drizzle` is rejected with a `SqlmdError` whose `code` is `READ_ONLY`. Drizzle wraps it in its own `DrizzleQueryError`, so check with `isSqlmdError(error, 'READ_ONLY')` or `findSqlmdError(error)`.

## Postgres with PGlite (`sqlmd/pg`)

**Same function, different import.** Both Drizzle entry points export `drizzleMd` with the same options and the same result. The import path picks the engine:

```typescript
import { drizzleMd } from 'sqlmd/drizzle'; // SQLite (better-sqlite3 or node:sqlite), sqliteTable schemas
import { drizzleMd } from 'sqlmd/pg'; // PGlite (Postgres), pgTable schemas
```

`sqlmd/pg` builds the same index in [PGlite](https://pglite.dev), Postgres compiled to WebAssembly, so you can write `pgTable` schemas and use Postgres features: array operators, `jsonb`, full-text search, `pg_trgm` and GIN indexes. The watcher, diagnostics, `report()`, `reload()`, `subscribe()`, `settled()` and `close()` behave exactly as in the SQLite entry points.

```bash
npm install sqlmd drizzle-orm @electric-sql/pglite
# optional, for faster startup:
npm install @electric-sql/pglite-prepopulatedfs
```

```typescript
import { arrayContains, eq } from 'drizzle-orm';
import { boolean, jsonb, pgEnum, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { drizzleMd } from 'sqlmd/pg';

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

YAML lists fill array columns (`text().array()`, enum arrays, `integer().array()`, each item checked against the element type), and mappings or lists fill `json()` / `jsonb()` columns. `pgEnum` types are created for you. On the first load each folder is bulk-loaded with one `COPY … FROM '/dev/blob'`; if Postgres rejects a row (say a `varchar(40)` overflow), sqlmd retries file by file and reports only that file as a `sql-error`.

Options on top of the SQLite ones:

| Option | Meaning |
| --- | --- |
| `prepopulated` | Start from the `@electric-sql/pglite-prepopulatedfs` snapshot instead of running initdb (about 0.5 s instead of 1.4 s). Default: use it when it is installed **and** its version is exactly the installed `@electric-sql/pglite` version; on a mismatch or a failed load PGlite starts normally and `onDiagnostic` gets a `startup-warning`. `true` requires it (a missing package, a mismatch or a failed load is a `CONFIG` error). `false` skips it. |
| `pglite` | Extra PGlite options, such as `extensions: { pg_trgm }` or `debug`. The data directory is always in memory. |
| `setup` | SQL run once as the database owner after the tables are created and before the files load, e.g. `CREATE EXTENSION pg_trgm`. Trusted code only, see below. |

**Indexes.** `index()` and `uniqueIndex()` declared in a `pgTable` are created for you:

- **Columns:** single or multiple, with an operator class (`t.title.op('gin_trgm_ops')`), `.asc()` / `.desc()` and `.nullsFirst()` / `.nullsLast()`.
- **Expressions:** `sql` expressions, e.g. ``sql`lower(${t.title})` ``.
- **Methods:** any method set with `.using()`, such as gin, gist, brin or hash.
- **Clauses:** `.where()` for partial indexes and `.with()` storage options.

Unique indexes exist before the files load, so a file that repeats a unique value is reported as a `sql-error` and the other files still load. Other indexes are built once after the first load, which is faster than updating them row by row, followed by `ANALYZE`.

There are a few limits:

- `.concurrently()` is ignored.
- Expressions and `.where()` must not contain bound values: write literals into the SQL text or use `sql.raw()`. Otherwise you get a `CONFIG` error.
- An index Postgres cannot build, such as an operator class from an extension you didn't create in `setup`, fails startup with a `CONFIG` error that names the index.

```typescript
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { index, pgTable, text } from 'drizzle-orm/pg-core';

export const posts = pgTable(
  'posts',
  { id: text().primaryKey(), title: text().notNull(), tags: text().array().notNull().default([]) },
  (t) => [
    index('posts_tags_gin').using('gin', t.tags),
    index('posts_title_trgm').using('gin', t.title.op('gin_trgm_ops')),
  ],
);

const md = await drizzleMd({
  root: 'content',
  schema: { posts },
  pglite: { extensions: { pg_trgm } },
  setup: 'CREATE EXTENSION pg_trgm', // the extension must exist before its index is built
});
```

> **`setup` is trusted startup code.** It runs with full database rights, outside the read-only guard below. Treat it like a migration you wrote yourself: never build it from user input, request data, markdown file contents or anything else untrusted.

**Read-only.** Every statement from `md.db` runs in its own `READ ONLY` transaction, as a select-only `md_reader` role, and is always rolled back. Writes, DDL, `DO` blocks, `SET` and writes hidden in `WITH` are rejected with the same `READ_ONLY` error code as the SQLite entry points. `md.live()` first runs the query through that read-only path before PGlite's live extension sees it.

**Trade-offs.** Pick `sqlmd/pg` when you want Postgres features or already use Postgres schemas; the SQLite entry points stay the lighter default.

| | SQLite (`sqlmd`, `sqlmd/drizzle`) | PGlite (`sqlmd/pg`) |
| --- | --- | --- |
| Memory | a few MB | about 570–700 MB RSS per instance (WebAssembly heap) |
| Startup | milliseconds | about 0.5 s with the snapshot, 1.4 s without |
| Per-query overhead | microseconds | about 0.2 ms (transaction, role switch, rollback) |
| Runtimes | Node.js | Node.js; not Cloudflare Workers (PGlite needs more memory and WebAssembly than Workers allow) |
| Extras | | arrays, `jsonb`, enums, extensions, schema-declared GIN/GiST/expression indexes, live queries |

## Limitations

- Read-only in version 1: edit the markdown files to change data.
- One folder per table and one level deep: files in sub-folders are not read.
- The plain `sqlmd` entry infers columns once, on the first load. A frontmatter key that first appears later is counted in `report()` as an unknown key until you restart or declare it in `columns`.
- The plain `sqlmd` entry only offers SQLite; Postgres is available through `sqlmd/pg` with a Drizzle schema.
- `sqlmd/drizzle` and `sqlmd/pg`: generated columns, `blob({ mode: 'buffer' })` columns and unique or foreign key constraints are not applied to the index. Foreign keys still work in joins and relations.
- The index lives in memory and is rebuilt on every start.
- The watcher doesn't notice a table folder that is created after `watch()` starts.
- `sqlmd/pg`: only tables and enums in the default `public` schema; foreign keys, checks and generated columns declared in `pgTable` are not applied yet (indexes and unique indexes are).

## Roadmap

- **Writes:** `insert`, `update` and `delete` through SQL and Drizzle that create, rewrite or remove the matching files, keeping unknown frontmatter keys and key order so git diffs stay small.
- **File migrations:** a drizzle-kit style diff between two schemas that renames, adds and drops frontmatter keys in the files.
- **Index cache:** keep the index on disk and rebuild only when the schema hash or files change.
- Nested folders and per-table glob patterns.

See [docs/design.md](docs/design.md) for the architecture and the migrations plan.

## Migrating from drizzle-md

sqlmd is the new name of [`drizzle-md`](https://www.npmjs.com/package/drizzle-md) (0.1.0), because the core is querying markdown and Drizzle is now optional. The Drizzle API is unchanged apart from the import path and the error helper names:

| drizzle-md 0.1.0 | sqlmd 0.1.0 |
| --- | --- |
| `npm install drizzle-md drizzle-orm` | `npm install sqlmd drizzle-orm` |
| `import { drizzleMd } from 'drizzle-md'` | `import { drizzleMd } from 'sqlmd/drizzle'` |
| `import { drizzleMd } from 'drizzle-md/pg'` | `import { drizzleMd } from 'sqlmd/pg'` |
| `findDrizzleMdError`, `isDrizzleMdError` | `findSqlmdError`, `isSqlmdError` |
| types `DrizzleMdError`, `DrizzleMdErrorCode`, `DrizzleMdIndex` | `SqlmdError`, `SqlmdErrorCode`, `SqlmdIndex` |
| `error.name === 'DrizzleMdError'` | `error.name === 'SqlmdError'` |
| error messages start with `drizzle-md` | they start with `sqlmd` |

Options, results, error codes (`READ_ONLY`, `VALIDATION`, `CONFIG`, `CLOSED`), diagnostics, the watcher and `sqlmd/pg`'s `live()`, `setup`, `prepopulated` and indexes behave exactly as before. `drizzle-orm` is now an optional peer dependency: install it yourself (you already do with drizzle-md). If you don't need Drizzle, the new `sqlmd` entry point queries the same folders with plain SQL.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the setup, the coding conventions and the lint rules.

## License

[Apache-2.0](LICENSE)
