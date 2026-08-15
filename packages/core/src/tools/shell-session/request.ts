import fs from 'node:fs/promises'
import path from 'node:path'

import { errorMessage } from '../../utils.js'
import type { InitialWaitPolicy, WaitPolicy } from './types.js'

export const INITIAL_YIELD_MS = 10_000
export const MIN_INITIAL_YIELD_MS = 250
export const MAX_INITIAL_YIELD_MS = 30_000
export const WINDOWS_INITIAL_YIELD_FLOOR_MS = 10_000
export const EMPTY_INTERACT_YIELD_MS = 5_000
export const MAX_EMPTY_INTERACT_YIELD_MS = 300_000
export const NON_EMPTY_INTERACT_YIELD_MS = 250
export const MAX_NON_EMPTY_INTERACT_YIELD_MS = 30_000
export const MAX_NODE_TIMER_MS = 2_147_483_647
export const MAX_TERMINAL_DIMENSION = 1_000

export interface ShellWaitInput {
  yieldTimeMs?: number
  runInBackground?: boolean
}

export interface ShellInteractWaitInput {
  yieldTimeMs?: number
  block?: boolean
  timeout?: number
}

function safeInteger(value: number, name: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isFinite(value) || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be a safe integer between ${minimum} and ${maximum}`)
  }
  return value
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

export function normalizeInitialWait(
  input: ShellWaitInput,
  platform: NodeJS.Platform = process.platform,
): InitialWaitPolicy {
  if (input.yieldTimeMs !== undefined) safeInteger(input.yieldTimeMs, 'yieldTimeMs', 0)
  if (input.yieldTimeMs === 0) return { kind: 'immediate' }
  if (input.yieldTimeMs === undefined && input.runInBackground === true) return { kind: 'immediate' }

  const requested = input.yieldTimeMs ?? INITIAL_YIELD_MS
  const platformMinimum = platform === 'win32' ? WINDOWS_INITIAL_YIELD_FLOOR_MS : MIN_INITIAL_YIELD_MS
  return { kind: 'timed', ms: clamp(requested, platformMinimum, MAX_INITIAL_YIELD_MS) }
}

export function normalizeInteractWait(input: ShellInteractWaitInput, hasChars: boolean): WaitPolicy {
  if (input.yieldTimeMs !== undefined) safeInteger(input.yieldTimeMs, 'yieldTimeMs', 0)
  if (input.timeout !== undefined) safeInteger(input.timeout, 'timeout', 0)
  if (input.yieldTimeMs === 0) return { kind: 'immediate' }
  if (input.yieldTimeMs !== undefined) return clampInteractTimed(input.yieldTimeMs, hasChars)
  if (Object.hasOwn(input, 'block') && input.block === false) return { kind: 'immediate' }
  if (input.block === true) {
    return input.timeout === 0 ? { kind: 'immediate' } : clampInteractTimed(input.timeout ?? 30_000, hasChars)
  }
  return { kind: 'timed', ms: hasChars ? NON_EMPTY_INTERACT_YIELD_MS : EMPTY_INTERACT_YIELD_MS }
}

function clampInteractTimed(value: number, hasChars: boolean): WaitPolicy {
  const minimum = hasChars ? NON_EMPTY_INTERACT_YIELD_MS : EMPTY_INTERACT_YIELD_MS
  const maximum = hasChars ? MAX_NON_EMPTY_INTERACT_YIELD_MS : MAX_EMPTY_INTERACT_YIELD_MS
  return { kind: 'timed', ms: clamp(value, minimum, maximum) }
}

export function normalizeHardTimeout(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  return safeInteger(value, 'timeout', 1, MAX_NODE_TIMER_MS)
}

export function normalizeMaxOutputTokens(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  return safeInteger(value, 'maxOutputTokens', 1)
}

export function normalizeTerminalResize(cols: unknown, rows: unknown): { cols: number; rows: number } | undefined {
  if (cols === undefined && rows === undefined) return undefined
  if (typeof cols !== 'number' || typeof rows !== 'number') {
    throw new TypeError('shellOutput.cols and shellOutput.rows must be provided together as numbers')
  }
  return {
    cols: safeInteger(cols, 'cols', 1, MAX_TERMINAL_DIMENSION),
    rows: safeInteger(rows, 'rows', 1, MAX_TERMINAL_DIMENSION),
  }
}

export async function resolveShellCwd(projectCwd: string, requestedCwd: string | undefined): Promise<string> {
  if (projectCwd.includes('\0') || requestedCwd?.includes('\0')) throw new Error('Shell cwd must not contain NUL bytes')
  const unresolved = path.resolve(projectCwd, requestedCwd ?? '.')
  let canonical: string
  try {
    canonical = await fs.realpath(unresolved)
    const stat = await fs.stat(canonical)
    if (!stat.isDirectory()) throw new Error('path is not a directory')
    await fs.access(canonical)
  } catch (error) {
    const reason = errorMessage(error)
    throw new Error(`Invalid shell cwd "${requestedCwd ?? projectCwd}": ${reason}`)
  }
  return canonical
}
