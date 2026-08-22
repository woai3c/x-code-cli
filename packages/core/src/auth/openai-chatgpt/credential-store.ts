import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

import { userXcodeDir } from '../../utils.js'
import { acquireFileLock } from '../../utils/file-lock.js'
import { OpenAIChatGPTAuthError } from './types.js'
import type { OpenAIChatGPTCredentials } from './types.js'

const LOCK_STALE_MS = 2 * 60 * 1000
const LOCK_WAIT_MS = 2 * 60 * 1000
const MAX_DATE_MS = 8_640_000_000_000_000

export function openAIChatGPTCredentialPath(): string {
  return path.join(userXcodeDir(), 'auth', 'openai-chatgpt.json')
}

function lockPath(): string {
  return `${openAIChatGPTCredentialPath()}.lock`
}

export function hasOpenAIChatGPTCredentials(): boolean {
  return fsSync.existsSync(openAIChatGPTCredentialPath())
}

function validateCredentials(value: unknown): OpenAIChatGPTCredentials {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OpenAIChatGPTAuthError(
      'credentials-invalid',
      'Stored ChatGPT credentials are invalid. Run `xc logout`, then `xc login`.',
    )
  }
  const item = value as Partial<OpenAIChatGPTCredentials>
  const optionalStringsValid = [item.accountId, item.idToken, item.email, item.planType].every(
    (field) => field === undefined || typeof field === 'string',
  )
  if (
    item.version !== 1 ||
    typeof item.accessToken !== 'string' ||
    !item.accessToken ||
    typeof item.refreshToken !== 'string' ||
    !item.refreshToken ||
    typeof item.expiresAt !== 'number' ||
    !Number.isSafeInteger(item.expiresAt) ||
    item.expiresAt < 0 ||
    item.expiresAt > MAX_DATE_MS ||
    !optionalStringsValid ||
    (item.isFedRamp !== undefined && typeof item.isFedRamp !== 'boolean')
  ) {
    throw new OpenAIChatGPTAuthError(
      'credentials-invalid',
      'Stored ChatGPT credentials are invalid. Run `xc logout`, then `xc login`.',
    )
  }
  return item as OpenAIChatGPTCredentials
}

export async function readOpenAIChatGPTCredentials(): Promise<OpenAIChatGPTCredentials> {
  let raw: string
  try {
    raw = await fs.readFile(openAIChatGPTCredentialPath(), 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new OpenAIChatGPTAuthError('login-required', 'ChatGPT is not signed in. Run `xc login`.')
    }
    throw new OpenAIChatGPTAuthError('credentials-invalid', 'Could not read stored ChatGPT credentials.', {
      cause: err,
    })
  }

  try {
    return validateCredentials(JSON.parse(raw) as unknown)
  } catch (err) {
    if (err instanceof OpenAIChatGPTAuthError) throw err
    throw new OpenAIChatGPTAuthError(
      'credentials-invalid',
      'Stored ChatGPT credentials are invalid. Run `xc logout`, then `xc login`.',
      {
        cause: err,
      },
    )
  }
}

export function readOpenAIChatGPTCredentialsSync(): OpenAIChatGPTCredentials {
  let raw: string
  try {
    raw = fsSync.readFileSync(openAIChatGPTCredentialPath(), 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new OpenAIChatGPTAuthError('login-required', 'ChatGPT is not signed in. Run `xc login`.')
    }
    throw new OpenAIChatGPTAuthError('credentials-invalid', 'Could not read stored ChatGPT credentials.', {
      cause: err,
    })
  }
  try {
    return validateCredentials(JSON.parse(raw) as unknown)
  } catch (err) {
    if (err instanceof OpenAIChatGPTAuthError) throw err
    throw new OpenAIChatGPTAuthError(
      'credentials-invalid',
      'Stored ChatGPT credentials are invalid. Run `xc logout`, then `xc login`.',
      {
        cause: err,
      },
    )
  }
}

export async function writeOpenAIChatGPTCredentials(credentials: OpenAIChatGPTCredentials): Promise<void> {
  validateCredentials(credentials)
  const target = openAIChatGPTCredentialPath()
  const directory = path.dirname(target)
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const temp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    await fs.writeFile(temp, JSON.stringify(credentials, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 })
    await fs.rename(temp, target)
    if (process.platform !== 'win32') await fs.chmod(target, 0o600)
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined)
  }
}

export async function clearOpenAIChatGPTCredentials(): Promise<boolean> {
  try {
    await fs.unlink(openAIChatGPTCredentialPath())
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

function abortError(): Error {
  return new OpenAIChatGPTAuthError('cancelled', 'ChatGPT authentication was cancelled.')
}

async function acquireLock(signal?: AbortSignal): Promise<() => Promise<void>> {
  const target = lockPath()
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  let lease
  try {
    lease = await acquireFileLock(target, {
      staleMs: LOCK_STALE_MS,
      waitMs: LOCK_WAIT_MS,
      retryMs: 50,
      signal,
    })
  } catch (err) {
    if (signal?.aborted) throw abortError()
    throw err
  }
  if (!lease) throw new OpenAIChatGPTAuthError('oauth-failed', 'Timed out waiting for the ChatGPT credential lock.')
  return () => lease.release()
}

export async function withOpenAIChatGPTCredentialLock<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const release = await acquireLock(signal)
  try {
    return await action()
  } finally {
    await release()
  }
}
