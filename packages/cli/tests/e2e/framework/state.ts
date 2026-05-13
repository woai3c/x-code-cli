// Persistent run state (gitignored). Allows `--resume` to skip passed scenarios.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { RunState, ScenarioResult } from './types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// state lives next to scenarios/ — one folder above this file.
const STATE_DIR = path.resolve(__dirname, '..', '.state')
const STATE_FILE = path.join(STATE_DIR, 'last-run.json')

export async function loadState(): Promise<RunState | null> {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf-8')
    return JSON.parse(raw) as RunState
  } catch {
    return null
  }
}

export async function saveState(state: RunState): Promise<void> {
  await fs.mkdir(STATE_DIR, { recursive: true })
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2) + '\n', 'utf-8')
}

export async function updateScenarioResult(state: RunState, result: ScenarioResult): Promise<void> {
  state.results[result.id] = result
  await saveState(state)
}

export function failedIds(state: RunState): string[] {
  return Object.values(state.results)
    .filter((r) => r.status === 'failed')
    .map((r) => r.id)
}

export function passedIds(state: RunState): string[] {
  return Object.values(state.results)
    .filter((r) => r.status === 'passed')
    .map((r) => r.id)
}

export function summarize(state: RunState): { passed: number; failed: number; skipped: number; total: number } {
  let passed = 0,
    failed = 0,
    skipped = 0
  for (const r of Object.values(state.results)) {
    if (r.status === 'passed') passed++
    else if (r.status === 'failed') failed++
    else skipped++
  }
  return { passed, failed, skipped, total: passed + failed + skipped }
}
