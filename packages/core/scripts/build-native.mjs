import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { nativeSourceSha256 } from './native-artifacts.mjs'

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

async function main() {
  if (process.platform !== 'win32') return
  if (process.arch !== 'x64' && process.arch !== 'arm64') {
    throw new Error(`Windows shell supervisor does not support architecture ${process.arch}`)
  }

  const nativeDir = path.join(coreDir, 'native', 'windows-job-supervisor')
  await run('cargo', ['build', '--release', '--locked', '--manifest-path', path.join(nativeDir, 'Cargo.toml')])

  const source = path.join(nativeDir, 'target', 'release', 'xc-shell-supervisor.exe')
  const destinationDir = path.join(coreDir, 'dist', 'native', 'windows', process.arch)
  const destination = path.join(destinationDir, 'xc-shell-supervisor.exe')
  await fs.mkdir(destinationDir, { recursive: true })
  await fs.copyFile(source, destination)
  const bytes = await fs.readFile(destination)
  const sha256 = createHash('sha256').update(bytes).digest('hex')

  const manifestPath = path.join(coreDir, 'dist', 'native', 'windows', 'manifest.json')
  let manifest = { protocolVersion: 2, artifacts: {} }
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  } catch {}
  manifest.protocolVersion = 2
  manifest.sourceSha256 = await nativeSourceSha256(coreDir)
  manifest.artifacts[process.arch] = {
    file: `${process.arch}/xc-shell-supervisor.exe`,
    sha256,
  }
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

await main()
