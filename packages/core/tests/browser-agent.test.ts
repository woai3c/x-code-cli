import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { sanitizeBrowserDiagnostic } from '../src/agent/browser/diagnostics.js'
import { withBrowserOperation } from '../src/agent/browser/operation-lock.js'
import { PLAYWRIGHT_MCP_PACKAGE, buildBrowserServerConfig } from '../src/agent/browser/registry.js'
import { createBuiltInRegistry, createSubAgentRegistry } from '../src/agent/sub-agents/registry.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('buildBrowserServerConfig', () => {
  it('defaults to npx @playwright/mcp on the chrome channel, headed', () => {
    const c = buildBrowserServerConfig({}) as { command: string; args: string[] }
    const joined = [c.command, ...c.args].join(' ')
    expect(joined).toContain(PLAYWRIGHT_MCP_PACKAGE)
    expect(joined).not.toContain('@latest')
    expect(joined).toContain('--browser chrome')
    expect(joined).not.toContain('--headless')
    expect(joined).toContain('--caps vision')
    expect(joined).not.toContain('--extension')
  })

  it('adds --headless and honours the browser channel', () => {
    const c = buildBrowserServerConfig({ headless: true, browser: 'msedge' }) as { command: string; args: string[] }
    const joined = [c.command, ...c.args].join(' ')
    expect(joined).toContain('--headless')
    expect(joined).toContain('--browser msedge')
  })

  it('a command override bypasses the npx default', () => {
    const c = buildBrowserServerConfig({ command: 'my-server', args: ['--port', '7'] })
    expect(c).toMatchObject({ command: 'my-server', args: ['--port', '7'] })
  })

  it('redirects saved output off the repo via --output-dir (npx path only)', async () => {
    const def = buildBrowserServerConfig({}) as { command: string; args: string[] }
    expect(def.args).toContain('--output-dir')
    const outputDirectory = def.args[def.args.indexOf('--output-dir') + 1]!
    expect(path.dirname(outputDirectory)).toBe(os.tmpdir())
    expect(path.basename(outputDirectory)).toMatch(/^x-code-browser-/)
    if (process.platform !== 'win32') {
      expect((await fs.stat(outputDirectory)).mode & 0o777).toBe(0o700)
    }

    const override = buildBrowserServerConfig({ command: 'my-server', args: ['--port', '7'] })
    if (!('command' in override)) throw new Error('Expected a stdio browser server config')
    expect(override.args).not.toContain('--output-dir')
  })

  it('keeps vision capabilities stable by default and supports an explicit tree-only override', () => {
    const off = buildBrowserServerConfig({ vision: false }) as { command: string; args: string[] }
    expect([off.command, ...off.args].join(' ')).not.toContain('--caps vision')

    const on = buildBrowserServerConfig({}) as { command: string; args: string[] }
    expect([on.command, ...on.args].join(' ')).toContain('--caps vision')
  })
})

describe('browser sub-agent registration gating', () => {
  let home: string
  let prevHome: string | undefined
  beforeAll(async () => {
    prevHome = process.env.X_CODE_HOME
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-browser-'))
    process.env.X_CODE_HOME = home
  })
  afterAll(async () => {
    if (prevHome === undefined) delete process.env.X_CODE_HOME
    else process.env.X_CODE_HOME = prevHome
    await fs.rm(home, { recursive: true, force: true })
  })

  it('registers the browser agent only when includeBrowser is true and omits it by default', async () => {
    const on = await createSubAgentRegistry({ includeBrowser: true })
    expect(on.names()).toContain('browser')

    const off = await createSubAgentRegistry({ includeBrowser: false })
    expect(off.names()).not.toContain('browser')

    const def = await createSubAgentRegistry()
    expect(def.names()).not.toContain('browser')
  })

  it('setBrowserEnabled toggles the browser agent in place (the /browser on|off mechanism)', () => {
    const reg = createBuiltInRegistry()
    expect(reg.names()).not.toContain('browser')
    reg.setBrowserEnabled(true)
    expect(reg.names()).toContain('browser')
    reg.setBrowserEnabled(false)
    expect(reg.names()).not.toContain('browser')
  })
})

describe('browser diagnostic sanitization and operation lock', () => {
  it('redacts environment-style, labeled, and JSON secrets while retaining ordinary diagnostic fields', () => {
    const diagnostic = [
      'OPENAI_API_KEY=sk-short-but-sensitive',
      'CUSTOM_TOKEN="custom-secret"',
      "password: 'hunter2'",
      '{"password":"json-password","accessToken":"json-access","safe":"visible"}',
    ].join('\n')

    const result = sanitizeBrowserDiagnostic(diagnostic)
    for (const secret of ['sk-short-but-sensitive', 'custom-secret', 'hunter2', 'json-password', 'json-access']) {
      expect(result).not.toContain(secret)
    }
    expect(result).toContain('"safe":"visible"')
    expect(sanitizeBrowserDiagnostic('monkey=visible tokenCount=3 keyboard=ready')).toBe(
      'monkey=visible tokenCount=3 keyboard=ready',
    )
  })

  it('serializes complete browser transactions in FIFO order and removes aborted waiters cleanly', async () => {
    const firstCanFinish = deferred()
    const events: string[] = []

    const first = withBrowserOperation(undefined, async () => {
      events.push('first:start')
      await firstCanFinish.promise
      events.push('first:end')
    })
    const second = withBrowserOperation(undefined, async () => {
      events.push('second:start')
      events.push('second:end')
    })

    await Promise.resolve()
    expect(events).toEqual(['first:start'])
    firstCanFinish.resolve()
    await Promise.all([first, second])
    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end'])

    const blocker = deferred()
    const controller = new AbortController()
    const hold = withBrowserOperation(undefined, () => blocker.promise)
    const aborted = withBrowserOperation(controller.signal, async () => undefined)
    const third = withBrowserOperation(undefined, async () => 'third')

    controller.abort(new DOMException('cancelled', 'AbortError'))
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' })
    blocker.resolve()
    await hold
    await expect(third).resolves.toBe('third')
  })
})
