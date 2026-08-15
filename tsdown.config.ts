import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    name: 'host',
    entry: {
      index: 'src/index.ts',
      invariant: 'src/invariant.ts',
    },
    format: 'esm',
    outDir: 'lib',
    dts: true,
    sourcemap: false,
    clean: true,
  },
  {
    name: 'client',
    entry: {
      client: 'src/client/index.ts',
    },
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    outDir: 'lib',
    outExtensions: () => ({
      js: '.cjs',
      dts: '.d.cts',
    }),
    dts: true,
    sourcemap: false,
    clean: false,
    banner: {
      js: `window.__ModuleLoader__.load({
  id: "dsh-request-flight-recorder",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;`,
    },
    footer: {
      js: `    return module.exports;
  }
});`,
    },
  },
])
