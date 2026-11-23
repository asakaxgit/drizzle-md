// Checks the built bundles for problems the tests (which run against src/) can't see.
import { readFile } from 'node:fs/promises';

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');
const failures = [];

// Both SQLite entry points open node:sqlite on request.
for (const file of ['dist/index.js', 'dist/index.cjs', 'dist/drizzle.js', 'dist/drizzle.cjs']) {
  const code = await read(file);
  // node:sqlite only exists with the prefix; a bundler that strips it breaks driver: 'node:sqlite'.
  if (!code.includes("import('node:sqlite')") && !code.includes('import("node:sqlite")')) {
    failures.push(`${file}: expected import('node:sqlite')`);
  }
  if (/(?:import\(|from |require\()['"]sqlite['"]/.test(code)) {
    failures.push(`${file}: imports 'sqlite' without the node: prefix`);
  }
}

// The main entry, and the shared type chunks it imports, must work without the optional
// drizzle-orm and PGlite peers installed.
const mainFiles = new Set([
  'dist/index.js',
  'dist/index.cjs',
  'dist/index.d.ts',
  'dist/index.d.cts',
]);
for (const file of mainFiles) {
  const code = await read(file);
  for (const [, chunk] of code.matchAll(/from '\.\/([^']+)\.(c?js)'/g)) {
    mainFiles.add(`dist/${chunk}.${file.endsWith('.d.cts') ? 'd.cts' : 'd.ts'}`);
  }
  for (const peer of ['drizzle-orm', '@electric-sql/pglite']) {
    if (new RegExp(`(?:import\\(|from |require\\()['"]${peer}`).test(code)) {
      failures.push(`${file}: imports the optional peer ${peer}`);
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('dist check passed');
