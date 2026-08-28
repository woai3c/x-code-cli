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

async function copyIfChanged(relativeFile) {
  const sourcePath = path.join(sourceDir, relativeFile)
  const destinationPath = path.join(destinationDir, relativeFile)
  const sourceBytes = await fs.readFile(sourcePath)
  const destinationBytes = await fs.readFile(destinationPath).catch(() => null)
  if (destinationBytes?.equals(sourceBytes)) return
  await fs.mkdir(path.dirname(destinationPath), { recursive: true })
  const temporaryPath = `${destinationPath}.${process.pid}.tmp`
  await fs.writeFile(temporaryPath, sourceBytes)
  await fs.rename(temporaryPath, destinationPath)
}

if (!destinationIsCurrent) {
  await fs.mkdir(destinationDir, { recursive: true })
  for (const architecture of Object.values(sourceManifest.artifacts)) {
    for (const artifact of Object.values(architecture)) await copyIfChanged(artifact.file)
  }
  const manifestPath = path.join(destinationDir, 'manifest.json')
  const temporaryManifestPath = `${manifestPath}.${process.pid}.tmp`
  await fs.writeFile(temporaryManifestPath, `${JSON.stringify(sourceManifest, null, 2)}\n`, 'utf8')
  await fs.rename(temporaryManifestPath, manifestPath)
}
