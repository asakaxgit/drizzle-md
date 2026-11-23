import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', pg: 'src/pg/index.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  // Keep `node:` in imports: `node:sqlite` only exists with the prefix.
  removeNodeProtocol: false,
  // import.meta.url in the CommonJS build (used to find installed package versions).
  shims: true,
  outExtension({ format }) {
    return { js: format === 'cjs' ? '.cjs' : '.js' };
  },
});
