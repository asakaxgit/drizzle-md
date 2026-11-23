# Contributing to sqlmd

## Setup

```bash
npm ci
npm run lint       # biome ci: lint and format check, the same as CI
npm run format     # apply Biome fixes and formatting
npm run typecheck
npm test           # vitest with coverage thresholds
npm run build
npm run check:dist # checks the built bundles: the node:sqlite import, and no drizzle-orm or PGlite in the main entry
```

The `sqlmd/pg` tests start several PGlite instances (about 0.5 s and 600 MB each, one at a time per test file), so `npm test` takes a few seconds longer than the SQLite tests alone.

## Entry points

`src/index.ts` (`sqlmd`) must not import `drizzle-orm`, `@electric-sql/pglite` or anything under `src/drizzle/` or `src/pg/`, directly or through a shared module: those are optional peer dependencies. Put Drizzle-specific code in `src/drizzle/` (shared by both Drizzle entry points) or `src/pg/`. `npm run check:dist` enforces this on the built files.

Commits need a DCO sign-off (`git commit -s`) and an English message in the
[Conventional Commits](https://www.conventionalcommits.org) style, e.g. `feat: add nested folders`.

## Coding conventions

- **Functions:** arrow functions only. No `function` declarations or function expressions.
- **No classes.** Build plain objects with factory functions, e.g. `createStore()` returns an object of closures.
- **`interface` or `type`:**
  - Use `interface` for object shapes: options, results, API responses, events, and public library types users may extend through declaration merging.
  - Use `type` for unions, intersections, primitive aliases, and computed types (conditional and mapped types, such as `TableKeys`).
- **Type assertions:** no `as` casts except `as const`. Prefer `satisfies` to check a value's shape.
- **No `any` or `unknown`.** Narrow with `typeof`, `instanceof` and type guards. When a function must accept "any value", use a generic parameter (`<T>(value: T)`). Parsed YAML is typed as `JsonValue`.
- ESM sources with `.js` import specifiers; strict `tsconfig.json` with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.

## Lint rules

[Biome](https://biomejs.dev) enforces these in CI (`biome ci .`). Everything below is an error:

| Convention | Rule |
| --- | --- |
| No `function` declarations | `nursery/useConsistentFunctionStyle` with `style: "expression"` |
| Arrow functions instead of function expressions | `complexity/useArrowFunction` |
| No classes | GritQL plugin [`biome-plugins/no-class.grit`](biome-plugins/no-class.grit) (Biome has no built-in rule) |
| No `as` casts except `as const` | `nursery/noUnsafeTypeAssertion`, plus `style/useAsConstAssertion` |
| No non-null assertions (`!`) | `style/noNonNullAssertion` |
| No `any` | `suspicious/noExplicitAny` |
| No `unknown` | GritQL plugin [`biome-plugins/no-unknown.grit`](biome-plugins/no-unknown.grit) (Biome has no built-in rule) |
| No `enum`, `namespace` or parameter properties | `style/noEnum`, `style/noNamespace`, `style/noParameterProperties` |
| `import type` and `node:` imports | `style/useImportType`, `style/useNodejsImportProtocol` |

`interface` versus `type` is a review convention: Biome's `useConsistentTypeDefinitions` can only force one of the two, so it is off.

There is one suppression in `src/`: the sqlite-proxy callback in `src/drizzle/drizzle-md.ts` returns `rows[0]!` for `get` queries, because Drizzle reads "no row" from an undefined `rows` although its callback type says `any[]`. The `biome-ignore` comment there explains it.
