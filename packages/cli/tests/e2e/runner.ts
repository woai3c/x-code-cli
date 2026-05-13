#!/usr/bin/env tsx
// e2e runner. Entry point invoked via `pnpm test:e2e`.
//
// Modes (mutually exclusive; if none provided, runs interactive flow):
//   --resume         Re-run scenarios that failed (or never ran) in last-run.json
//   --all            Re-run every scenario, fresh
//   --filter <glob>  Substring match against scenario id (e.g. --filter shell)
//   --list           Just list scenarios + skip status, exit
//   --model <id>     Skip interactive model selection, use this model id (or alias)
//   --keep-tmp       Don't delete tmp dirs even on pass (debugging only)
//   --max-turns N    Pass through to CLI
//   --print-jsonl    Print each scenario's jsonl path after running
import * as p from '@clack/prompts'

import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { makeExpect } from './framework/expect.js'
import { runCliInDir } from './framework/harness.js'
import {
  DEFAULT_MODEL,
  availableModels,
  describeDetectedKeys,
  loadDotenv,
  resolveModelArg,
} from './framework/models.js'
import { failedIds, loadState, saveState, summarize, updateScenarioResult } from './framework/state.js'
import { ScenarioAssertionError } from './framework/types.js'
import type { RunCliOptions, RunState, Scenario, ScenarioContext, ScenarioResult } from './framework/types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI_BIN = path.resolve(__dirname, '..', '..', 'dist', 'cli.js')
const SCENARIOS_DIR = path.resolve(__dirname, 'scenarios')
const DEFAULT_TIMEOUT_MS = 180_000

function parseArgs(argv: string[]): {
  resume: boolean
  all: boolean
  filter?: string
  list: boolean
  model?: string
  keepTmp: boolean
  printJsonl: boolean
  maxTurns?: number
} {
  const out = { resume: false, all: false, list: false, keepTmp: false, printJsonl: false } as ReturnType<
    typeof parseArgs
  >
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--resume') out.resume = true
    else if (a === '--all') out.all = true
    else if (a === '--list') out.list = true
    else if (a === '--keep-tmp') out.keepTmp = true
    else if (a === '--print-jsonl') out.printJsonl = true
    else if (a === '--filter') out.filter = argv[++i]
    else if (a === '--model') out.model = argv[++i]
    else if (a === '--max-turns') out.maxTurns = Number(argv[++i])
    else if (a === '--help' || a === '-h') {
      printHelp()
      process.exit(0)
    } else {
      console.error(`Unknown arg: ${a}`)
      process.exit(2)
    }
  }
  return out
}

function printHelp(): void {
  console.log(`X-Code CLI — e2e suite runner

Usage:
  pnpm test:e2e [flags]

Flags:
  --all                Run every scenario (skip resume logic)
  --resume             Run only scenarios that failed (or were skipped) last time
  --filter <substr>    Run only scenarios whose id matches substring
  --model <id|alias>   Skip prompt; use this model (default: ${DEFAULT_MODEL})
  --list               List scenarios + last-run status, then exit
  --keep-tmp           Keep tmpdir after pass (failures keep regardless)
  --print-jsonl        Print path to session jsonl after each scenario
  --max-turns N        Pass --max-turns N through to the CLI

By default (no mode flag) runs interactively, prompting for model + scope.
`)
}

async function loadScenarios(): Promise<Scenario[]> {
  const entries = await fs.readdir(SCENARIOS_DIR)
  const tsFiles = entries.filter((e) => e.endsWith('.ts')).sort()
  const scenarios: Scenario[] = []
  for (const file of tsFiles) {
    const mod = (await import(pathToFileURL(path.join(SCENARIOS_DIR, file)).href)) as { default?: Scenario }
    if (mod.default && mod.default.id && typeof mod.default.run === 'function') {
      scenarios.push(mod.default)
    }
  }
  return scenarios
}

async function setupTmpDir(scenarioId: string): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), `xc-e2e-${scenarioId}-`))
  return tmp
}

async function cleanupTmpDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true })
  } catch {
    // best-effort
  }
}

async function runOne(
  scenario: Scenario,
  modelId: string,
  env: Record<string, string>,
  globalOpts: ReturnType<typeof parseArgs>,
): Promise<ScenarioResult> {
  if (scenario.requires && !scenario.requires(env)) {
    return {
      id: scenario.id,
      name: scenario.name,
      status: 'skipped',
      durationSec: 0,
      skipReason: scenario.requiresReason ?? 'prerequisite not met',
    }
  }

  const tmpDir = await setupTmpDir(scenario.id)
  const startedAt = Date.now()

  const ctx: ScenarioContext = {
    tmpDir,
    modelId,
    cliBin: CLI_BIN,
    env,
    writeFile: async (rel, content) => {
      const abs = path.join(tmpDir, rel)
      await fs.mkdir(path.dirname(abs), { recursive: true })
      await fs.writeFile(abs, content, 'utf-8')
    },
    readFile: async (rel) => fs.readFile(path.join(tmpDir, rel), 'utf-8'),
    fileExists: async (rel) => {
      try {
        await fs.access(path.join(tmpDir, rel))
        return true
      } catch {
        return false
      }
    },
    mkdir: async (rel) => {
      await fs.mkdir(path.join(tmpDir, rel), { recursive: true })
    },
    runCli: (prompt, options?: RunCliOptions) =>
      runCliInDir(
        // Most scenarios run from tmpDir, but a few need a nested cwd to
        // exercise the AGENTS.md monorepo-chain walker.
        options?.cwd ?? tmpDir,
        prompt,
        {
          cliBin: CLI_BIN,
          modelId,
          defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
        },
        {
          ...options,
          args: [
            ...(globalOpts.maxTurns ? ['--max-turns', String(globalOpts.maxTurns)] : []),
            ...(options?.args ?? []),
          ],
        },
      ),
    expect: makeExpect(tmpDir),
  }

  let lastJsonl = ''
  const runCli = ctx.runCli
  ctx.runCli = async (prompt, options) => {
    const r = await runCli(prompt, options)
    if (r.sessionJsonlPath) lastJsonl = r.sessionJsonlPath
    return r
  }

  let result: ScenarioResult
  try {
    await scenario.run(ctx)
    result = {
      id: scenario.id,
      name: scenario.name,
      status: 'passed',
      durationSec: +((Date.now() - startedAt) / 1000).toFixed(2),
      lastSessionJsonl: lastJsonl,
    }
  } catch (err) {
    const msg = err instanceof ScenarioAssertionError ? err.message : err instanceof Error ? err.message : String(err)
    result = {
      id: scenario.id,
      name: scenario.name,
      status: 'failed',
      durationSec: +((Date.now() - startedAt) / 1000).toFixed(2),
      error: msg,
      lastSessionJsonl: lastJsonl,
      tmpDir,
    }
    if (lastJsonl) {
      // Copy the failing jsonl out so it survives the tmpdir nuke if the user retries.
      try {
        const stash = path.join(__dirname, '.state', `failed-${scenario.id}.jsonl`)
        await fs.mkdir(path.dirname(stash), { recursive: true })
        await fs.copyFile(lastJsonl, stash)
        result.lastSessionJsonl = stash
      } catch {}
    }
  }

  if (result.status === 'passed' && !globalOpts.keepTmp) {
    await cleanupTmpDir(tmpDir)
  }
  if (result.status === 'failed') {
    // Surface tmpDir on failure so user can inspect.
    result.tmpDir = tmpDir
  }
  return result
}

function pickScenarios(
  scenarios: Scenario[],
  filter: string | undefined,
  resume: boolean,
  state: RunState | null,
): Scenario[] {
  let chosen = scenarios
  if (filter) chosen = chosen.filter((s) => s.id.includes(filter) || s.name.includes(filter))
  if (resume && state) {
    const failed = new Set(failedIds(state))
    // Resume = scenarios that failed OR were never run before.
    chosen = chosen.filter((s) => failed.has(s.id) || !state.results[s.id])
  }
  return chosen
}

async function interactiveSelectModel(env: Record<string, string>, defaultModel: string): Promise<string> {
  const opts = availableModels(env)
  if (opts.length === 0) {
    console.error('❌ No API keys detected in env / .env. Set DEEPSEEK_API_KEY (or another) and retry.')
    process.exit(1)
  }
  const detected = describeDetectedKeys(env)
  if (detected.length > 0) {
    console.log('Detected API keys:')
    for (const line of detected) console.log(line)
    console.log()
  }

  // Build options list with default first.
  const seen = new Set<string>()
  const items: { value: string; label: string; hint?: string }[] = []
  if (opts.some((o) => o.modelId === defaultModel)) {
    items.push({ value: defaultModel, label: defaultModel, hint: 'default' })
    seen.add(defaultModel)
  }
  for (const o of opts) {
    if (seen.has(o.modelId)) continue
    items.push({ value: o.modelId, label: o.modelId })
    seen.add(o.modelId)
  }

  const picked = await p.select({
    message: 'Select model to test with',
    options: items,
    initialValue: items[0]?.value,
  })
  if (p.isCancel(picked)) {
    p.cancel('Cancelled.')
    process.exit(0)
  }
  return picked as string
}

async function interactiveSelectMode(state: RunState | null): Promise<'all' | 'resume' | 'cancel'> {
  if (!state) return 'all'
  const sum = summarize(state)
  if (sum.failed === 0) {
    console.log(`Last run: ${sum.passed} passed, 0 failed, ${sum.skipped} skipped — running all fresh.`)
    return 'all'
  }
  const picked = await p.select({
    message: `Last run: ${sum.passed} passed, ${sum.failed} failed, ${sum.skipped} skipped. What now?`,
    options: [
      { value: 'resume', label: `Resume failed (${sum.failed})`, hint: 'recommended after a code change' },
      { value: 'all', label: `Run all (${sum.total})` },
      { value: 'cancel', label: 'Cancel' },
    ],
    initialValue: 'resume',
  })
  if (p.isCancel(picked)) return 'cancel'
  return picked as 'all' | 'resume' | 'cancel'
}

function fmtDuration(sec: number): string {
  return `${sec.toFixed(1)}s`
}

function printSummary(results: ScenarioResult[]): void {
  console.log()
  console.log('─'.repeat(60))
  const pass = results.filter((r) => r.status === 'passed').length
  const fail = results.filter((r) => r.status === 'failed').length
  const skip = results.filter((r) => r.status === 'skipped').length
  console.log(`Summary: ${pass} passed, ${fail} failed, ${skip} skipped (${results.length} total)`)

  const failed = results.filter((r) => r.status === 'failed')
  if (failed.length > 0) {
    console.log()
    console.log('Failed scenarios:')
    for (const r of failed) {
      console.log(`  ✗ ${r.id} — ${r.name}`)
      console.log(`    error: ${r.error?.split('\n').slice(0, 3).join('\n           ') ?? '(no message)'}`)
      if (r.tmpDir) console.log(`    tmpDir: ${r.tmpDir}`)
      if (r.lastSessionJsonl) console.log(`    jsonl:  ${r.lastSessionJsonl}`)
      console.log(`    rerun:  pnpm test:e2e --filter ${r.id} --keep-tmp`)
    }
  }
  console.log()
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  if (!existsSync(CLI_BIN)) {
    console.error(`❌ CLI binary not found at ${CLI_BIN}`)
    console.error('   Run `pnpm build` first.')
    process.exit(1)
  }

  // Load env (.env + process.env)
  const env = await loadDotenv()
  const scenarios = await loadScenarios()

  // --list mode: just print and exit.
  if (args.list) {
    const state = await loadState()
    console.log(`Found ${scenarios.length} scenarios:`)
    for (const s of scenarios) {
      const last = state?.results[s.id]
      const status = last ? (last.status === 'passed' ? '✓' : last.status === 'failed' ? '✗' : '○') : '·'
      const skipNote = s.requires && !s.requires(env) ? ` [skipped: ${s.requiresReason}]` : ''
      console.log(`  ${status} ${s.id}  ${s.name}${skipNote}`)
    }
    return
  }

  // Resolve model
  let modelId: string
  if (args.model) {
    modelId = resolveModelArg(args.model)
  } else {
    const prevState = await loadState()
    const defaultModel = prevState?.model ?? DEFAULT_MODEL
    modelId = await interactiveSelectModel(env, defaultModel)
  }

  // Resolve scope (resume vs all vs filter)
  const prevState = await loadState()
  let scope: 'all' | 'resume' | 'cancel'
  if (args.all) scope = 'all'
  else if (args.resume) scope = 'resume'
  else if (args.filter)
    scope = 'all' // filter alone implies "all matching"
  else scope = await interactiveSelectMode(prevState)
  if (scope === 'cancel') {
    console.log('Cancelled.')
    return
  }

  const chosen = pickScenarios(scenarios, args.filter, scope === 'resume', prevState)
  if (chosen.length === 0) {
    console.log('No scenarios matched.')
    return
  }

  console.log(`\n▶ Model: ${modelId}`)
  console.log(
    `▶ Scope: ${scope === 'resume' ? `resume (${chosen.length} of ${scenarios.length})` : `all (${chosen.length})`}`,
  )
  if (args.filter) console.log(`▶ Filter: ${args.filter}`)
  console.log()

  // Prepare run state. Start fresh for scope='all', or merge resume results.
  const state: RunState =
    scope === 'all' || !prevState
      ? { model: modelId, startedAt: new Date().toISOString(), results: {} }
      : { model: modelId, startedAt: new Date().toISOString(), results: { ...prevState.results } }
  await saveState(state)

  const liveResults: ScenarioResult[] = []
  let counter = 0
  for (const scenario of chosen) {
    counter++
    const marker = `[${counter}/${chosen.length}]`
    process.stdout.write(`${marker} ${scenario.id} — ${scenario.name} ... `)
    const result = await runOne(scenario, modelId, env, args)
    liveResults.push(result)
    if (result.status === 'passed') {
      process.stdout.write(`✓ ${fmtDuration(result.durationSec)}\n`)
    } else if (result.status === 'skipped') {
      process.stdout.write(`○ skipped (${result.skipReason ?? 'n/a'})\n`)
    } else {
      process.stdout.write(`✗ ${fmtDuration(result.durationSec)}\n`)
      const errLine = (result.error ?? '').split('\n')[0]
      process.stdout.write(`    ${errLine}\n`)
    }
    if (args.printJsonl && result.lastSessionJsonl) {
      process.stdout.write(`    jsonl: ${result.lastSessionJsonl}\n`)
    }
    await updateScenarioResult(state, result)
  }

  printSummary(liveResults)

  const fail = liveResults.filter((r) => r.status === 'failed').length
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
