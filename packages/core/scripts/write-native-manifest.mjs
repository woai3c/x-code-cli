import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { WINDOWS_NATIVE_ARCHES, WINDOWS_NATIVE_ARTIFACTS, updateWindowsNativeManifest } from './native-artifacts.mjs'

const coreDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const windowsDir = process.argv[2]
  ? path.resolve(coreDir, process.argv[2])
  : path.join(coreDir, 'dist', 'native', 'windows')
const relative = path.relative(coreDir, windowsDir)
if (relative.startsWith('..') || path.isAbsolute(relative)) {
  throw new Error('Native manifest target must stay inside the Core package')
}

const buildEntries = []
if (process.argv.includes('--all-current')) {
  for (const arch of WINDOWS_NATIVE_ARCHES) {
    for (const artifactName of Object.keys(WINDOWS_NATIVE_ARTIFACTS)) buildEntries.push({ arch, artifactName })
  }
} else {
  for (let index = 3; index < process.argv.length; index++) {
    if (process.argv[index] !== '--built' || !process.argv[index + 1]) {
      throw new Error('Use --built <arch>:<artifact> for each rebuilt binary, or --all-current after rebuilding all')
    }
    const [arch, artifactName, extra] = process.argv[++index].split(':')
    if (extra !== undefined) throw new Error('Windows native build provenance must use <arch>:<artifact>')
    buildEntries.push({ arch, artifactName })
  }
}

await updateWindowsNativeManifest(coreDir, windowsDir, buildEntries)
