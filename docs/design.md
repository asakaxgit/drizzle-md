# drizzle-md design

## Goal

Let people keep content as plain markdown files in git and still query it with Drizzle: typed columns, `where`, joins across folders and aggregates, with no framework and no build step.

## Layout

- `root/<dir>/` is a table. `dir` defaults to the SQL table name.
- `root/<dir>/<key>.md` is a row. The file name without the extension fills the key column (`id` by default, or `tables.<name>.key`).
- YAML frontmatter keys fill columns by their Drizzle **property name**.
- The markdown body fills the body column (`body` by default, `tables.<name>.body`, or `false`).

## Architecture

```text
markdown files ──read──▶ parseMarkdown ──▶ buildRow ──▶ in-memory index ◀── sqlite-proxy / pg-proxy ◀── Drizzle db
      ▲                  (yaml AST →        (coerce +       (SQLite: better-sqlite3      (read-only
      │                   JsonValue)         defaults)       or node:sqlite; PGlite)       guard)
   fs.watch ──debounce──▶ queue ──▶ syncFile (checksum skip) ──▶ IndexBackend.apply ──▶ subscribe() / live()
```

| Module | Role |
| --- | --- |
| `schema.ts` | Picks the `SQLiteTable`s out of the schema with `is()`, reads `getTableConfig` / `getTableColumns`, assigns key/body/data roles, generates `CREATE TABLE` (columns, SQL types, `NOT NULL`, primary keys) and the schema hash. |
| `frontmatter.ts` | Splits the `---` block from the body and walks the YAML AST into `JsonValue`. YAML 1.2 core schema, so dates stay strings and nothing is typed `any`. |
| `coerce.ts` | Converts each value for its column (`dataType`, SQL type, enum values), applies `.default()`, `.$defaultFn()` and SQL defaults, then calls the column's own `mapToDriverValue`, so storage matches what Drizzle expects when reading. |
| `store.ts` | Per-table file state (checksum, key, diagnostics, unknown keys). Reads and plans every file of a folder, then hands the whole batch to the backend (`IndexBackend.apply`: delete keys, insert rows) in one transaction. If the batch fails it retries file by file, so only the file the database rejects becomes a `sql-error`. |
| `watcher.ts` | `fs.watch` per table folder, debounced per file. A missing file name in the event triggers a folder re-scan. |
| `core.ts` | Shared by both entry points: first load, `onInvalid`, the update queue, watcher, `subscribe`, `settled`, `reload`, `report` and `close`. |
| `read-only.ts` | The statement prefix check and the `READ_ONLY` / `CLOSED` errors. |
| `engine.ts` | The small synchronous SQLite driver surface (`exec`, `run`, `rows` as arrays, so joined columns with the same name survive) and the SQLite `IndexBackend`. |
| `drizzle-md.ts` | The SQLite entry point: creates the Drizzle db with `drizzle-orm/sqlite-proxy`. |
| `pg/schema.ts` | The Postgres `TableDialect` (`pgTable`, array and enum column types) and `CREATE TYPE … AS ENUM`. |
| `pg/backend.ts` | The PGlite `IndexBackend`: `COPY … FROM '/dev/blob'` for batches, `INSERT` for single files, SQL defaults evaluated as `::text`. |
| `pg/drizzle-md.ts` | The `drizzle-md/pg` entry point: PGlite startup, `drizzle-orm/pg-proxy` with the read-only transaction wrapper, and `live()`. |

`schema.ts` and `coerce.ts` take the dialect as a parameter (`TableDialect`, `RowContext`), so markdown parsing, coercion, defaults, validation and the watcher are one code path for SQLite and Postgres.

### Why sqlite-proxy

The proxy driver hands drizzle-md every SQL string, its parameters and the method (`all`, `get`, `values`, `run`). That one callback is where read-only is enforced and where the driver can be swapped, while Drizzle's query builder, result mapping and relational queries stay unchanged.

### Read-only enforcement

Two layers:

1. The statement must start with `SELECT`, `WITH`, `VALUES` or `EXPLAIN` (after comments). Everything else, including `PRAGMA`, is rejected with `READ_ONLY` before it reaches SQLite.
2. The connection runs with `PRAGMA query_only = ON` except while drizzle-md itself applies file changes, so `WITH … DELETE` is rejected by SQLite too.

All work is synchronous inside one event-loop turn, so toggling `query_only` can't interleave with a user query.

### Postgres entry point (`drizzle-md/pg`)

PGlite runs Postgres 18 in WebAssembly in the same process. It is an optional peer dependency, loaded only by `drizzle-md/pg`, so the default entry point never pulls it in.

- **One name, two imports.** `drizzle-md` and `drizzle-md/pg` both export `drizzleMd` with the same options and result shape; the import path picks the engine, as Drizzle's own `drizzle()` does per driver.
- **Startup.** `PGlite.create()` with the `@electric-sql/pglite-prepopulatedfs` snapshot when it is installed (about 0.45 s instead of about 1.4 s for initdb). The snapshot is a data directory made by one exact PGlite build, so drizzle-md reads both installed `package.json` versions first and uses it only when they are equal. By default a mismatch or a failed load falls back to initdb and reports a `startup-warning` through `onDiagnostic`; `prepopulated: true` turns both into a `CONFIG` error, and `false` skips the snapshot. Then `CREATE TYPE` for enums, `CREATE TABLE` per model, the user's `setup` SQL, and the `md_reader` role with `SELECT` on every table in `public`.
- **Loading.** The first load of a folder is one transaction: `DELETE … WHERE key = ANY($1)` followed by one `COPY … FROM '/dev/blob'` in text format (5,000 rows in about 92 ms in the benchmark). Single-file updates from the watcher use a parameterised `INSERT`. Values come from each column's own `mapToDriverValue`, so `text[]` gets Postgres array literals and `jsonb` gets JSON text. SQL defaults are evaluated as `select (<default>)::text`, which keeps every type in Postgres' input format.
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

PGlite runs one transaction at a time, so drizzle-md's own writes (as the session user, in their own transaction) never interleave with a user query. All three SQLSTATEs map to the `READ_ONLY` error code.

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

## 0.2 scope: `drizzle-md/pg`

- In: `pgTable` schemas, `pgEnum`, array columns from YAML lists, `json`/`jsonb` from mappings, COPY bulk load with per-file fallback, read-only transactions under `md_reader`, the prepopulated snapshot, `setup` SQL and PGlite extensions, `live()`.
- Follow-ups:
  - create the indexes declared in `pgTable` (GIN, expression and `opclass` indexes) instead of asking for `setup` SQL,
  - generated columns (e.g. a stored `tsvector` for full-text search),
  - tables and enums in other Postgres schemas (`pgSchema`),
  - `live.incrementalQuery` for large result sets,
  - an on-disk PGlite data directory as the index cache.

## Migrations plan

The user asked for migrations to be covered. They come in two stages, because what a "migration" means depends on whether drizzle-md owns the files.

### Stage 1: index schema handling (now)

The index is derived data, so it never needs migrating, only rebuilding.

- **Structure hash.** `report().schemaHash` hashes the DDL, folders and column roles. Version 1 rebuilds the in-memory index on every start, so the hash is informational. When an on-disk cache lands, a hash mismatch means "drop and rebuild".
- **Rebuild on change.** A schema change is a code change, which restarts the process and rebuilds the index. The watcher only handles file changes.
- **Drift report.** `report().tables[].unknownKeys` counts frontmatter keys that match no column, and `diagnostics()` lists files that no longer fit (missing required columns, wrong types). Together they show how far the files are from the schema before anyone writes a migration.

### Stage 2: file migrations (when writes land)

Once drizzle-md can write files, schema changes can be applied to the files themselves, in the style of drizzle-kit:

1. **Snapshot.** Store a JSON snapshot of the table models (the same data the schema hash is made from) next to the content, e.g. `content/.drizzle-md/snapshot.json`.
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
- [Astro content collections](https://docs.astro.build/en/guides/content-collections/): typed folder-per-collection content with Zod schemas, but no SQL. Astro now points SQL users at Drizzle, which is the gap drizzle-md fills.

## Open questions

- Should `better-sqlite3` become an optional peer dependency, with `node:sqlite` as the default once Node 22.16+ is the floor?
- Frontmatter keys match Drizzle property names. Should SQL column names (e.g. `author_id`) also be accepted?
- Should the watcher also watch `root` so table folders created later are picked up?
- `drizzle-md/pg`: should indexes declared in `pgTable` be created automatically, replacing most uses of `setup`?
