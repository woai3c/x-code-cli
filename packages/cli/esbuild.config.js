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

// Plugin to fix signal-exit ESM/CJS interop
// signal-exit@3 exports a single CJS function (module.exports = fn), so the default import IS the onExit function.
// Ink expects `import { onExit } from 'signal-exit'`, so we alias default → onExit.
const signalExitFixPlugin = {
  name: 'fix-signal-exit-default',
  setup(build) {
    build.onResolve({ filter: /^signal-exit$/ }, (args) => {
      // Don't intercept imports from our own shim (breaks recursion)
      if (args.namespace === 'signal-exit-shim') return
      return {
        path: args.path,
        namespace: 'signal-exit-shim',
        pluginData: { resolveDir: args.resolveDir },
      }
    })
    build.onLoad({ filter: /.*/, namespace: 'signal-exit-shim' }, (args) => ({
      contents: `export { default as default, default as onExit } from 'signal-exit';`,
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
