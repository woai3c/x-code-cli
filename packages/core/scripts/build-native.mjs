import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { WINDOWS_NATIVE_ARTIFACTS, writeWindowsNativeManifest } from './native-artifacts.mjs'

const coreDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: coreDir, stdio: 'inherit', windowsHide: true })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} exited with code ${code ?? 'unknown'}`))
    })
  })
}

function requestedArtifacts() {
  const optionIndex = process.argv.indexOf('--artifact')
  if (optionIndex < 0) return Object.keys(WINDOWS_NATIVE_ARTIFACTS)
  const value = process.argv[optionIndex + 1]
  if (value === 'all') return Object.keys(WINDOWS_NATIVE_ARTIFACTS)
  if (!value || !WINDOWS_NATIVE_ARTIFACTS[value]) {
    throw new Error(`Unknown Windows native artifact ${value ?? '(missing)'}`)
  }
  return [value]
}

async function ensureCompleteDistNativeRoot(destinationRoot) {
  const prebuiltRoot = path.join(coreDir, 'native', 'prebuilt', 'windows')
  try {
    await fs.access(path.join(destinationRoot, 'manifest.json'))
  } catch {
    await fs.mkdir(path.dirname(destinationRoot), { recursive: true })
    await fs.cp(prebuiltRoot, destinationRoot, { recursive: true })
  }
}

async function main() {
  if (process.platform !== 'win32') return
  if (process.arch !== 'x64' && process.arch !== 'arm64') {
    throw new Error(`Windows native helpers do not support architecture ${process.arch}`)
  }

  const destinationRoot = path.join(coreDir, 'dist', 'native', 'windows')
  await ensureCompleteDistNativeRoot(destinationRoot)
  for (const artifactName of requestedArtifacts()) {
    const definition = WINDOWS_NATIVE_ARTIFACTS[artifactName]
    const nativeDir = path.join(coreDir, 'native', definition.sourceDirectory)
    await run('cargo', ['build', '--release', '--locked', '--manifest-path', path.join(nativeDir, 'Cargo.toml')])
    const source = path.join(nativeDir, 'target', 'release', definition.file)
    const destinationDir = path.join(destinationRoot, process.arch)
    await fs.mkdir(destinationDir, { recursive: true })
    await fs.copyFile(source, path.join(destinationDir, definition.file))
  }
  await writeWindowsNativeManifest(coreDir, destinationRoot)
}

await main()
