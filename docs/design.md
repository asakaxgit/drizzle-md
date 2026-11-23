# sqlmd design

## Goal

Let people keep content as plain markdown files in git and still query it: typed columns, `where`, joins across folders and aggregates, with no framework and no build step. Querying markdown is the core; Drizzle ORM is one optional way to do it.

## Entry points

| Import | Query surface | Schema | Engine | Needs |
| --- | --- | --- | --- | --- |
| `sqlmd` | `md.query(sql, params)`, ``md.sql`…` ``, `md.tables()` | inferred from frontmatter, or sqlmd column types | SQLite | nothing extra |
| `sqlmd/drizzle` | `md.db`, a read-only Drizzle SQLite database | `sqliteTable` | SQLite | `drizzle-orm` |
| `sqlmd/pg` | `md.db` (Drizzle Postgres) and `md.live()` | `pgTable`, `pgEnum` | PGlite | `drizzle-orm`, `@electric-sql/pglite` |

All three share the loader, validation, diagnostics, watcher and lifecycle (`core.ts`). The Drizzle entry points both export `drizzleMd`: the import path picks the engine, as Drizzle's own `drizzle()` does per driver. The main entry point never imports `drizzle-orm` or PGlite; `scripts/check-dist.mjs` fails the build if `dist/index.*` or a type chunk it imports does.

### The plain SQL entry point

- **Tables.** Without `tables`, every sub-folder of `root` not starting with `.` or `_` is a table named after the folder. With `tables`, only those are loaded, each with optional `dir`, `key`, `body` and `columns`.
- **Columns.** Six types (`text`, `integer`, `real`, `boolean`, `date`, `json`) map onto the same value kinds the Drizzle columns use, so `coerce.ts` checks them with the same code. Without `columns`, `columns.ts` reads every file once before the first load and picks one type per key: booleans, whole numbers, numbers, strings, or `json` for any list or mapping; mixed scalars widen to `text`. Inferred columns are never required. The key column is `TEXT PRIMARY KEY NOT NULL`, the body column `TEXT NOT NULL`.
- **Storage.** Booleans are `1` / `0`, dates ISO 8601 text, `json` columns JSON text for SQLite's `json_*` functions.
- **Queries.** `query()` runs one statement through the same two read-only layers as `sqlmd/drizzle` and returns rows as objects keyed by result column name. The template tag joins the strings with `?` and binds every value, so values never become SQL text.
- **Why not infer again on change.** The table structure is fixed after startup, like a Drizzle schema. New keys are counted in `report().unknownKeys`; declaring them or restarting adds them. Re-inferring under a running watcher would change the columns of a table between two queries.

## Layout

- `root/<dir>/` is a table. `dir` defaults to the SQL table name.
- `root/<dir>/<key>.md` is a row. The file name without the extension fills the key column (`id` by default, or `tables.<name>.key`).
- YAML frontmatter keys fill columns by name (the Drizzle **property name** in the Drizzle entry points).
- The markdown body fills the body column (`body` by default, `tables.<name>.body`, or `false`).

## Architecture

```text
markdown files ──read──▶ parseMarkdown ──▶ buildRow ──▶ in-memory index ◀── query() / sqlite-proxy / pg-proxy
      ▲                  (yaml AST →        (coerce +       (SQLite: better-sqlite3      (read-only
      │                   JsonValue)         defaults)       or node:sqlite; PGlite)       guard)
   fs.watch ──debounce──▶ queue ──▶ syncFile (checksum skip) ──▶ IndexBackend.apply ──▶ subscribe() / live()
```

| Module | Role |
| --- | --- |
| `model.ts` | The Drizzle-free table and column model (`TableModel`, `ColumnSpec`: value kind, SQL type, `notNull`, enum values, `bind`, `resolveDefault`) and the schema hash. Everything below `core.ts` works on it. |
| `columns.ts` | sqlmd column types, inference from frontmatter, and the `CREATE TABLE` for the plain SQL entry point. |
| `sqlmd.ts` | The `sqlmd` entry point: table discovery, `query()`, the `sql` tag and `tables()`. |
| `drizzle/schema.ts` | Picks the `SQLiteTable`s out of the schema with `is()`, reads `getTableConfig` / `getTableColumns`, assigns key/body/data roles, turns each Drizzle column into a `ColumnSpec` (its `dataType`, `mapToDriverValue` and defaults) and generates `CREATE TABLE` (columns, SQL types, `NOT NULL`, primary keys). |
| `frontmatter.ts` | Splits the `---` block from the body and walks the YAML AST into `JsonValue`. YAML 1.2 core schema, so dates stay strings and nothing is typed `any`. |
| `coerce.ts` | Converts each value for its column spec (value kind, SQL type, enum values), applies the spec's default, then its `bind`. For Drizzle columns those are `.default()`, `.$defaultFn()` and SQL defaults and the column's own `mapToDriverValue`, so storage matches what Drizzle expects when reading. |
| `store.ts` | Per-table file state (checksum, key, diagnostics, unknown keys). Reads and plans every file of a folder, then hands the whole batch to the backend (`IndexBackend.apply`: delete keys, insert rows) in one transaction. If the batch fails it retries file by file, so only the file the database rejects becomes a `sql-error`. |
| `watcher.ts` | `fs.watch` per table folder, debounced per file. A missing file name in the event triggers a folder re-scan. |
| `core.ts` | Shared by all three entry points: first load, `onInvalid`, the update queue, watcher, `subscribe`, `settled`, `reload`, `report` and `close`. |
| `read-only.ts` | The statement prefix check and the `READ_ONLY` / `CLOSED` errors. |
| `engine.ts` | The small synchronous SQLite driver surface (`exec`, `run`, `rows` as arrays, so joined columns with the same name survive, and `table` with column names) and the SQLite `IndexBackend`. |
| `drizzle/drizzle-md.ts` | The `sqlmd/drizzle` entry point: creates the Drizzle db with `drizzle-orm/sqlite-proxy`. |
| `pg/schema.ts` | The Postgres `TableDialect` (`pgTable`, array and enum column types, SQL defaults compiled as `::text`) and `CREATE TYPE … AS ENUM`. |
| `pg/indexes.ts` | `CREATE INDEX` for the `index()` / `uniqueIndex()` declared in each `pgTable`. |
| `pg/backend.ts` | The PGlite `IndexBackend`: `COPY … FROM '/dev/blob'` for batches, `INSERT` for single files, SQL defaults run as compiled by the dialect. |
| `pg/drizzle-md.ts` | The `sqlmd/pg` entry point: PGlite startup, `drizzle-orm/pg-proxy` with the read-only transaction wrapper, and `live()`. |

`drizzle/schema.ts` takes the dialect as a parameter (`TableDialect`) and `coerce.ts` the backend (`RowContext`), and both Drizzle dialects and the plain entry point produce the same `TableModel`, so markdown parsing, coercion, defaults, validation and the watcher are one code path for every entry point.

### Why sqlite-proxy

The proxy driver hands sqlmd every SQL string, its parameters and the method (`all`, `get`, `values`, `run`). That one callback is where read-only is enforced and where the driver can be swapped, while Drizzle's query builder, result mapping and relational queries stay unchanged.

### Read-only enforcement

Two layers:

1. The statement must start with `SELECT`, `WITH`, `VALUES` or `EXPLAIN` (after comments). Everything else, including `PRAGMA`, is rejected with `READ_ONLY` before it reaches SQLite.
2. The connection runs with `PRAGMA query_only = ON` except while sqlmd itself applies file changes, so `WITH … DELETE` is rejected by SQLite too.

All work is synchronous inside one event-loop turn, so toggling `query_only` can't interleave with a user query.

### Postgres entry point (`sqlmd/pg`)

PGlite runs Postgres 18 in WebAssembly in the same process. It is an optional peer dependency, loaded only by `sqlmd/pg`, so the other entry points never pull it in.

- **One name, two imports.** `sqlmd/drizzle` and `sqlmd/pg` both export `drizzleMd` with the same options and result shape; the import path picks the engine, as Drizzle's own `drizzle()` does per driver.
- **Startup.** `PGlite.create()` with the `@electric-sql/pglite-prepopulatedfs` snapshot when it is installed (about 0.45 s instead of about 1.4 s for initdb). The snapshot is a data directory made by one exact PGlite build, so sqlmd reads both installed `package.json` versions first and uses it only when they are equal. By default a mismatch or a failed load falls back to initdb and reports a `startup-warning` through `onDiagnostic`; `prepopulated: true` turns both into a `CONFIG` error, and `false` skips the snapshot. Then `CREATE TYPE` for enums, `CREATE TABLE` per model, the user's `setup` SQL, the `uniqueIndex()`es declared in the tables, and the `md_reader` role with `SELECT` on every table in `public`.
- **Loading.** The first load of a folder is one transaction: `DELETE … WHERE key = ANY($1)` followed by one `COPY … FROM '/dev/blob'` in text format (5,000 rows in about 92 ms in the benchmark). Single-file updates from the watcher use a parameterised `INSERT`. Values come from each column's own `mapToDriverValue`, so `text[]` gets Postgres array literals and `jsonb` gets JSON text. SQL defaults are evaluated as `select (<default>)::text`, which keeps every type in Postgres' input format.
- **Indexes.** `pg/indexes.ts` turns each `index()` / `uniqueIndex()` from `getTableConfig(table).indexes` into `CREATE INDEX`:
  - **Columns:** with their operator class, `DESC` and non-default `NULLS FIRST/LAST`.
  - **Expressions:** `sql` expressions are rendered like drizzle-kit does, with unqualified column names, and wrapped in parentheses.
  - **Clauses:** `USING <method>`, `WITH (…)` and `WHERE …`.
  - **Order of creation:** unique indexes are created before the load, so a duplicate surfaces through the store's per-file fallback as a `sql-error` instead of failing startup. All other indexes are built after the first COPY load, followed by `ANALYZE`.
  - **Ignored:** `.concurrently()`, and `ONLY`, because the tables are never partitioned and Drizzle's `.using()` always sets it.
  - **CONFIG errors:** bound parameters in an expression or `WHERE`, and an index Postgres rejects. Both name the index.
- **Querying.** `drizzle-orm/pg-proxy` hands every statement to one callback. PGlite returns timestamps, dates and intervals as text there, as the official `drizzle-orm/pglite` driver does, so Drizzle's own mapping applies.
- **Live queries.** `md.live(query, onResult)` runs the Drizzle query once through the read-only path, registers its SQL with PGlite's `live` extension (which watches the tables the plan touches), and re-runs the Drizzle query on every change so `onResult` gets typed, mapped rows. `close()` unsubscribes everything first.

#### Read-only enforcement in Postgres

`SET default_transaction_read_only = on` on the session is not enough: any statement can turn it off again. Instead each user statement runs as:

```sql
BEGIN;
SET TRANSACTION READ ONLY;
SET LOCAL ROLE md_reader;   -- SELECT only
<statement>;
ROLLBACK;                   -- always, even when it succeeded
```

1. The same prefix check as SQLite rejects anything that is not `SELECT`, `WITH`, `VALUES` or `EXPLAIN`, including `DO`, `SET`, `RESET` and DDL.
2. The read-only transaction rejects writes that pass the prefix check, such as `WITH d AS (DELETE …) SELECT …`, `EXPLAIN ANALYZE DELETE …` or `set_config('transaction_read_only', 'off', …)` (SQLSTATE 25006 / 25001).
3. The `md_reader` role limits what functions and tables a query can touch (42501). It is defence in depth, not a boundary: the session user is a superuser, so `set_config('role', …)` can switch back inside the transaction.
4. The rollback discards everything a statement did, including session settings changed with `set_config(…, false)`.

PGlite runs one transaction at a time, so sqlmd's own writes (as the session user, in their own transaction) never interleave with a user query. All three SQLSTATEs map to the `READ_ONLY` error code.

The `setup` option is deliberately outside all of this: it runs once at startup as the session user with full database rights. It is trusted code, like a migration, and must never contain untrusted or user-supplied input.

#### Trade-offs

| | SQLite | PGlite |
| --- | --- | --- |
| Memory | a few MB | about 570–700 MB RSS per instance |
| Startup | milliseconds | about 0.45 s with the snapshot, 1.4 s without |
| Per-query overhead | microseconds | about 0.2 ms (transaction, role switch, rollback) |
| Runtimes | Node.js | Node.js (tested); not Cloudflare Workers, whose 128 MB memory limit is far below PGlite's needs |

DuckDB was considered and rejected for now: no official Drizzle dialect, point lookups about 20× slower than SQLite, and a 95 MB install.

### Watcher

Ideas taken from Nuxt Content v3's dev mode: hash each file and skip unchanged ones, apply only the changed rows instead of rebuilding, and debounce bursts of events. Updates run one at a time through a queue; `settled()` waits for it. Invalid files during watch are reported, and their old row is removed so the index always mirrors the files.

## Version 1 scope

- In: read-only queries, typed columns, defaults, validation (`throw` or `skip` with `onDiagnostic`), drift report, watcher, `better-sqlite3` and `node:sqlite` drivers.
- Out: writes, file migrations, nested folders, an on-disk index, unique and foreign key constraints in the index, generated columns.

## 0.2 scope: `sqlmd/pg`

- In: `pgTable` schemas, `pgEnum`, indexes and unique indexes declared in `pgTable`, array columns from YAML lists, `json`/`jsonb` from mappings, COPY bulk load with per-file fallback, read-only transactions under `md_reader`, the prepopulated snapshot, `setup` SQL and PGlite extensions, `live()`.
- Follow-ups:
  - foreign keys and check constraints declared in `pgTable`,
  - generated columns (e.g. a stored `tsvector` for full-text search),
  - tables and enums in other Postgres schemas (`pgSchema`),
  - `live.incrementalQuery` for large result sets,
  - an on-disk PGlite data directory as the index cache.

## Migrations plan

The user asked for migrations to be covered. They come in two stages, because what a "migration" means depends on whether sqlmd owns the files.

### Stage 1: index schema handling (now)

The index is derived data, so it never needs migrating, only rebuilding.

- **Structure hash.** `report().schemaHash` hashes the DDL, folders and column roles. Version 1 rebuilds the in-memory index on every start, so the hash is informational. When an on-disk cache lands, a hash mismatch means "drop and rebuild".
- **Rebuild on change.** A schema change is a code change, which restarts the process and rebuilds the index. The watcher only handles file changes.
- **Drift report.** `report().tables[].unknownKeys` counts frontmatter keys that match no column, and `diagnostics()` lists files that no longer fit (missing required columns, wrong types). Together they show how far the files are from the schema before anyone writes a migration.

### Stage 2: file migrations (when writes land)

Once sqlmd can write files, schema changes can be applied to the files themselves, in the style of drizzle-kit:

1. **Snapshot.** Store a JSON snapshot of the table models (the same data the schema hash is made from) next to the content, e.g. `content/.sqlmd/snapshot.json`.
2. **Diff.** Compare the snapshot with the current schema: added, dropped and renamed columns, changed types, moved folders, changed key or body columns. Like drizzle-kit, ask whether a drop plus an add is really a rename.
3. **Plan.** Write a reviewable migration file listing per-file operations: `rename author → authorId`, `add draft = false`, `drop layout`, `move posts/ → blog/`.
4. **Apply.** Rewrite each file's frontmatter with the `yaml` Document API so that:
   - key order is kept, and a renamed key stays in its position,
   - unknown keys, comments and formatting are kept,
   - added keys are written only when there is no default (or when asked), so files stay minimal,
   - the body is never touched.
5. **Verify.** Reload, check the diagnostics are empty, and update the snapshot.

Type changes (e.g. text to timestamp) reuse `coerce.ts` to check every value before any file is written, so a migration either applies cleanly or reports the files that need hand edits.

## Prior art

- [Nuxt Content v3](https://content.nuxt.com/docs/advanced/database): collections per folder in SQLite with an incremental, checksum-based dev watcher. Nuxt-only, its own query API, no joins between collections.
- [MarkdownDB](https://github.com/flowershow/markdowndb): indexes markdown into SQLite for raw SQL. Frontmatter lands in one JSON column, no ORM.
- [mdql-db/mdql](https://github.com/mdql-db/mdql) (Rust CLI, published as `mdql` on crates.io and PyPI): the same folder-as-table idea with its own SQL engine and writes; H2 sections are columns and a loose body is rejected. Not a JavaScript library.
- [MDQL/mdql](https://github.com/MDQL/mdql) (Node, 2023, unmaintained): a SQL-like language over tasks, tags and headings, rendered back to markdown.
- [Astro content collections](https://docs.astro.build/en/guides/content-collections/): typed folder-per-collection content with Zod schemas, but no SQL. Astro now points SQL users at Drizzle, which is the gap sqlmd fills, with Drizzle as an option rather than a requirement.

## Open questions

- Should `better-sqlite3` become an optional peer dependency, with `node:sqlite` as the default once Node 22.16+ is the floor?
- Frontmatter keys match Drizzle property names. Should SQL column names (e.g. `author_id`) also be accepted?
- Should the watcher also watch `root` so table folders created later are picked up?
