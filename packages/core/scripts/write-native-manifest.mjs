import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { writeWindowsNativeManifest } from './native-artifacts.mjs'

const coreDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const windowsDir = process.argv[2]
  ? path.resolve(coreDir, process.argv[2])
  : path.join(coreDir, 'dist', 'native', 'windows')
const relative = path.relative(coreDir, windowsDir)
if (relative.startsWith('..') || path.isAbsolute(relative)) {
  throw new Error('Native manifest target must stay inside the Core package')
}

await writeWindowsNativeManifest(coreDir, windowsDir)
