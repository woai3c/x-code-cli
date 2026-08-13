import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { userXcodeDir } from '../utils.js'
import { isUuid } from './identity.js'

async function validateDirectoryIdentity(directory: string): Promise<void> {
  const stat = await fs.lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe peer runtime directory: ${directory}`)
  if (process.platform !== 'win32') {
    const uid = process.getuid?.()
    if (uid !== undefined && stat.uid !== uid)
      throw new Error(`Peer runtime directory has the wrong owner: ${directory}`)
  }
}

async function validateOwnerOnlyDirectory(directory: string): Promise<void> {
  await validateDirectoryIdentity(directory)
  if (process.platform !== 'win32' && ((await fs.lstat(directory)).mode & 0o777) !== 0o700) {
    throw new Error(`Peer runtime directory must have mode 0700: ${directory}`)
  }
}

export async function ensurePeerRuntimeDirectories(): Promise<{ registryDir: string; socketDir: string }> {
  const root = path.resolve(userXcodeDir())
  const runtime = path.join(root, 'runtime')
  const registryDir = path.join(runtime, 'peers')
  for (const [index, directory] of [root, runtime, registryDir].entries()) {
    await fs.mkdir(directory, { recursive: index === 0, mode: 0o700 }).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
    await validateDirectoryIdentity(directory)
    if (process.platform !== 'win32') await fs.chmod(directory, 0o700)
    await validateOwnerOnlyDirectory(directory)
  }
  const realRoot = await fs.realpath(root)
  const uid = process.getuid?.() ?? createHash('sha256').update(os.userInfo().username).digest('hex').slice(0, 8)
  const namespaceHash = createHash('sha256').update(realRoot).digest('hex').slice(0, 12)
  const socketDir = path.join(os.tmpdir(), `x-code-peers-${uid}-${namespaceHash}`)
  await fs.mkdir(socketDir, { recursive: false, mode: 0o700 }).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error
  })
  await validateDirectoryIdentity(socketDir)
  if (process.platform !== 'win32') await fs.chmod(socketDir, 0o700)
  await validateOwnerOnlyDirectory(socketDir)
  return { registryDir, socketDir }
}

export function peerRegistryDir(): string {
  return path.join(path.resolve(userXcodeDir()), 'runtime', 'peers')
}

export function peerRegistrationPath(instanceId: string): string {
  if (!isUuid(instanceId)) throw new Error('Peer instance ID must be a UUID')
  return path.join(peerRegistryDir(), `${instanceId}.json`)
}

export function peerSocketPath(socketDir: string, instanceId: string): string {
  if (!isUuid(instanceId)) throw new Error('Peer instance ID must be a UUID')
  return path.join(socketDir, `${instanceId.slice(0, 8)}.sock`)
}

export function isSocketPathInNamespace(address: string, socketDir: string): boolean {
  const resolvedAddress = path.resolve(address)
  const resolvedNamespace = path.resolve(socketDir)
  return path.dirname(resolvedAddress) === resolvedNamespace && path.basename(resolvedAddress).endsWith('.sock')
}
