// Checks the built bundles for problems the tests (which run against src/) can't see.
import { readFile } from 'node:fs/promises';

const failures = [];
for (const file of ['dist/index.js', 'dist/index.cjs']) {
  const code = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
  // node:sqlite only exists with the prefix; a bundler that strips it breaks driver: 'node:sqlite'.
  if (!code.includes("import('node:sqlite')") && !code.includes('import("node:sqlite")')) {
    failures.push(`${file}: expected import('node:sqlite')`);
  }
  if (/(?:import\(|from |require\()['"]sqlite['"]/.test(code)) {
    failures.push(`${file}: imports 'sqlite' without the node: prefix`);
  }
}
if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('dist check passed');
