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

const sourceManifest = await verifyWindowsNativeArtifacts(coreDir, sourceDir)
let destinationIsCurrent = false
try {
  const destinationManifest = await verifyWindowsNativeArtifacts(coreDir, destinationDir)
  destinationIsCurrent = JSON.stringify(destinationManifest) === JSON.stringify(sourceManifest)
} catch {
  // A missing, stale, or partial destination is replaced below.
}

if (!destinationIsCurrent) {
  await fs.rm(destinationDir, { recursive: true, force: true })
  await fs.mkdir(path.dirname(destinationDir), { recursive: true })
  await fs.cp(sourceDir, destinationDir, { recursive: true })
}
