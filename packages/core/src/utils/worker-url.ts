import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * Resolve a compiled worker entry URL across dev (`tsx` / Vitest running `.ts`
 * from `packages/core/src/...`), `tsc` output (`packages/core/dist/...`), and
 * `esbuild` CLI bundles (`packages/cli/dist/cli.js` + `dist/chunks/*.js`, where
 * worker entry points sit flat at `packages/cli/dist/<workerFileName>`).
 */
export function resolveCoreWorkerUrl(importMetaUrl: string, workerFileName: string): URL {
  const current = new URL(importMetaUrl)
  const callerPath = fileURLToPath(current)
  const callerDir = path.dirname(callerPath)
  if (callerPath.endsWith('.ts')) {
    let dir = callerDir
    for (let depth = 0; depth < 8; depth++) {
      if (path.basename(dir) === 'src') {
        const relDir = path.relative(dir, callerDir)
        return pathToFileURL(path.join(path.dirname(dir), 'dist', relDir, workerFileName))
      }
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  if (path.basename(callerDir) === 'chunks') return new URL(`../${workerFileName}`, current)
  return new URL(`./${workerFileName}`, current)
}

/** Build a standard AbortError, preserving `signal.reason` when it is already an Error. */
export function createAbortError(signal?: AbortSignal, fallbackMessage = 'The operation was aborted'): Error {
  return signal?.reason instanceof Error ? signal.reason : new DOMException(fallbackMessage, 'AbortError')
}
