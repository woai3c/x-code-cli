import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { verifyWindowsNativeArtifacts } from './native-artifacts.mjs'

const coreDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceDir = path.join(coreDir, 'native', 'prebuilt', 'windows')
const destinationDir = path.join(coreDir, 'dist', 'native', 'windows')
const relativeDestination = path.relative(coreDir, destinationDir)
if (relativeDestination.startsWith('..') || path.isAbsolute(relativeDestination)) {
  throw new Error('Native artifact destination escaped the Core package')
}

await verifyWindowsNativeArtifacts(coreDir, sourceDir)
await fs.rm(destinationDir, { recursive: true, force: true })
await fs.mkdir(path.dirname(destinationDir), { recursive: true })
await fs.cp(sourceDir, destinationDir, { recursive: true })
