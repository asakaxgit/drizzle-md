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
markdown files ──read──▶ parseMarkdown ──▶ buildRow ──▶ in-memory SQLite ◀── sqlite-proxy ◀── Drizzle db
      ▲                  (yaml AST →        (coerce +        (better-sqlite3      (read-only
      │                   JsonValue)         defaults)        or node:sqlite)       guard)
   fs.watch ──debounce──▶ queue ──▶ syncFile (checksum skip) ──▶ upsert / delete ──▶ subscribe()
```

| Module | Role |
| --- | --- |
| `schema.ts` | Picks the `SQLiteTable`s out of the schema with `is()`, reads `getTableConfig` / `getTableColumns`, assigns key/body/data roles, generates `CREATE TABLE` (columns, SQL types, `NOT NULL`, primary keys) and the schema hash. |
| `frontmatter.ts` | Splits the `---` block from the body and walks the YAML AST into `JsonValue`. YAML 1.2 core schema, so dates stay strings and nothing is typed `any`. |
| `coerce.ts` | Converts each value for its column (`dataType`, SQL type, enum values), applies `.default()`, `.$defaultFn()` and SQL defaults, then calls the column's own `mapToDriverValue`, so storage matches what Drizzle expects when reading. |
| `store.ts` | Per-table file state (checksum, key, diagnostics, unknown keys). Applies one file or a whole folder in a transaction. |
| `watcher.ts` | `fs.watch` per table folder, debounced per file. A missing file name in the event triggers a folder re-scan. |
| `engine.ts` | The small synchronous driver surface: `exec`, `run`, `rows` (arrays, so joined columns with the same name survive). |
| `drizzle-md.ts` | Wires it together and creates the Drizzle db with `drizzle-orm/sqlite-proxy`. |

### Why sqlite-proxy

The proxy driver hands drizzle-md every SQL string, its parameters and the method (`all`, `get`, `values`, `run`). That one callback is where read-only is enforced and where the driver can be swapped, while Drizzle's query builder, result mapping and relational queries stay unchanged.

### Read-only enforcement

Two layers:

1. The statement must start with `SELECT`, `WITH`, `VALUES` or `EXPLAIN` (after comments). Everything else, including `PRAGMA`, is rejected with `READ_ONLY` before it reaches SQLite.
2. The connection runs with `PRAGMA query_only = ON` except while drizzle-md itself applies file changes, so `WITH … DELETE` is rejected by SQLite too.

All work is synchronous inside one event-loop turn, so toggling `query_only` can't interleave with a user query.

### Watcher

Ideas taken from Nuxt Content v3's dev mode: hash each file and skip unchanged ones, apply only the changed rows instead of rebuilding, and debounce bursts of events. Updates run one at a time through a queue; `settled()` waits for it. Invalid files during watch are reported, and their old row is removed so the index always mirrors the files.

## Version 1 scope

- In: read-only queries, typed columns, defaults, validation (`throw` or `skip` with `onDiagnostic`), drift report, watcher, `better-sqlite3` and `node:sqlite` drivers.
- Out: writes, file migrations, nested folders, an on-disk index, unique and foreign key constraints in the index, generated columns.

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
