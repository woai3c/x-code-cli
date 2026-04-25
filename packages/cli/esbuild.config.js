import esbuild from 'esbuild'

import { builtinModules } from 'node:module'
import { fileURLToPath } from 'node:url'

// ESM polyfills — provide __dirname, __filename, and require() for CJS compat
const ESM_POLYFILLS = `
import { fileURLToPath as ___fileURLToPath } from 'node:url';
import { dirname as ___dirname_fn } from 'node:path';
import { createRequire as ___createRequire } from 'node:module';
var __filename = ___fileURLToPath(import.meta.url);
var __dirname = ___dirname_fn(__filename);
var require = ___createRequire(import.meta.url);
`

// Plugin to stub out react-devtools-core (optional ink dev dependency)
const stubPlugin = {
  name: 'stub-devtools',
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: 'react-devtools-core',
      namespace: 'stub',
    }))
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: 'export default undefined;',
      loader: 'js',
    }))
  },
}

// Plugin to fix entities subpath resolution (entities@4.x uses ./lib/decode, consumers expect ./decode)
const entitiesFixPlugin = {
  name: 'fix-entities-subpath',
  setup(build) {
    const entitiesBase = '../../node_modules/.pnpm/node_modules/entities/lib/esm'
    build.onResolve({ filter: /^entities\/(decode|escape)$/ }, (args) => {
      const subpath = args.path.split('/')[1]
      return {
        path: fileURLToPath(new URL(`${entitiesBase}/${subpath}.js`, import.meta.url)),
      }
    })
  },
}

// Plugin to fix signal-exit ESM/CJS interop across v3 and v4.
// v3 ships `module.exports = fn` (no named `onExit`) — used by Ink@6.6.9.
// v4 ships `{ onExit }` (no default) — used by execa@9.
// Both versions coexist in the tree (pnpm scopes them per-consumer, Node ESM
// finds each one correctly at dev time). esbuild resolves `signal-exit` once
// per import site, so the shim below normalizes both shapes — `import onExit`
// and `import { onExit }` both yield the function regardless of which version
// was picked.
const signalExitFixPlugin = {
  name: 'fix-signal-exit-default',
  setup(build) {
    build.onResolve({ filter: /^signal-exit$/ }, (args) => {
      if (args.namespace === 'signal-exit-shim') return
      return {
        path: args.path,
        namespace: 'signal-exit-shim',
        pluginData: { resolveDir: args.resolveDir },
      }
    })
    build.onLoad({ filter: /.*/, namespace: 'signal-exit-shim' }, (args) => ({
      contents: `
        import * as _m from 'signal-exit';
        // Bracket access via a variable key so esbuild can't statically
        // prove that 'default' is missing from the v4 namespace and emit
        // an "import-is-undefined" warning. The runtime behavior is the
        // same as _m.default, but esbuild stops trying to constant-fold it.
        const _ns = _m;
        const _defaultKey = 'default';
        const _raw = _ns[_defaultKey] ?? _ns;
        const _fn = typeof _raw === 'function' ? _raw : (_raw.onExit ?? _ns.onExit);
        export { _fn as onExit };
        export default _fn;
      `,
      loader: 'js',
      resolveDir: args.pluginData.resolveDir,
    }))
  },
}

await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/cli.js',
  jsx: 'automatic',
  sourcemap: true,
  plugins: [stubPlugin, entitiesFixPlugin, signalExitFixPlugin],
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  banner: {
    js: '#!/usr/bin/env node\n' + ESM_POLYFILLS,
  },
  external: [
    // Node.js built-ins (both prefixed and unprefixed for CJS compat)
    ...builtinModules,
    ...builtinModules.map((m) => `node:${m}`),
    // Native addons that can't be bundled
    '@vscode/ripgrep',
  ],
})
