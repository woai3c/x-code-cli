import fs from 'node:fs/promises'
import path from 'node:path'

import { createTestWorkspace } from '../fixtures/cli-test-helpers.js'
import type { TestWorkspace } from '../fixtures/cli-test-helpers.js'
import { startFakeProvider } from '../fixtures/fake-provider-server.js'
import type { FakeProvider, ScriptedResponse } from '../fixtures/fake-provider-server.js'
import { createTuiHarness } from './harness.js'
import type { TuiHarness } from './harness.js'
import { lastPromptLine } from './screen.js'

export interface TuiTestContext {
  harness: TuiHarness
  provider: FakeProvider
  workspace: TestWorkspace
}

interface TuiTestOptions {
  args?: string[]
  columns?: number
  rows?: number
  env?: NodeJS.ProcessEnv
  seedTheme?: boolean
  beforeStart?: (workspace: TestWorkspace) => Promise<void>
}

function safeName(name: string): string {
  return name.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '')
}

async function saveFailureArtifacts(name: string, context: TuiTestContext): Promise<string> {
  const artifactDir = path.join(import.meta.dirname, '.artifacts', safeName(name))
  await fs.rm(artifactDir, { recursive: true, force: true })
  await fs.mkdir(artifactDir, { recursive: true })
  await Promise.all([
    fs.writeFile(path.join(artifactDir, 'terminal.raw.txt'), context.harness.raw(), 'utf-8'),
    fs.writeFile(path.join(artifactDir, 'screen.txt'), context.harness.text(), 'utf-8'),
  ])
  const sessionDir = path.join(context.workspace.cwd, '.x-code', 'sessions')
  await fs.cp(sessionDir, path.join(artifactDir, 'sessions'), { recursive: true }).catch(() => undefined)
  return artifactDir
}

export async function withTui(
  name: string,
  responses: ScriptedResponse[],
  run: (context: TuiTestContext) => Promise<void>,
  options: TuiTestOptions = {},
): Promise<void> {
  const provider = await startFakeProvider(responses)
  const workspace = await createTestWorkspace(`xc-pty-${safeName(name)}-`)
  await options.beforeStart?.(workspace)
  const harness = await createTuiHarness({
    workspace,
    provider,
    ...(options.columns ? { columns: options.columns } : {}),
    ...(options.rows ? { rows: options.rows } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.seedTheme !== undefined ? { seedTheme: options.seedTheme } : {}),
  })
  const context = { harness, provider, workspace }
  try {
    await harness.startCli(options.args)
    await run(context)
  } catch (error) {
    const artifactDir = await saveFailureArtifacts(name, context)
    const detail = error instanceof Error ? error : new Error(String(error))
    detail.message += `\nPTY output tail: ${JSON.stringify(context.harness.raw().slice(-2000))}`
    detail.message += `\nPTY diagnostics: ${artifactDir}`
    throw detail
  } finally {
    await harness.dispose()
    await provider.close()
    await workspace.cleanup()
  }
}

export function inputLine(harness: TuiHarness): string {
  // terminalScreen() trims trailing spaces, so an empty live prompt is
  // represented as just `❯`. Requiring `❯ ` made repeated prompts
  // compare against the previous scrollback entry instead of the live input.
  return lastPromptLine(harness.screen())
}

export async function typeInput(harness: TuiHarness, text: string): Promise<void> {
  const before = inputLine(harness)
  harness.write(text)
  await harness.waitForScreen(
    () => inputLine(harness) !== before && inputLine(harness).includes(text),
    `input text ${JSON.stringify(text)}`,
  )
}

export async function submitInput(harness: TuiHarness, text: string): Promise<void> {
  await typeInput(harness, text)
  harness.key('enter')
}

export async function exitTui(harness: TuiHarness): Promise<void> {
  harness.key('ctrl-c')
  await harness.waitForText('Press Ctrl+C again to exit')
  harness.key('ctrl-c')
  const result = await harness.waitForCliExit()
  expect(result.exitCode).toBe(0)
}
