// Tests for the browser sub-agent: the launch-config builder (pure) and the
// config-gated registration (the agent only appears in the registry when
// enabled). The actual @playwright/mcp connection is NOT exercised here — it
// would spawn npx + a browser, which is too heavy / networked for CI.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { PLAYWRIGHT_MCP_PACKAGE, buildBrowserServerConfig } from '../src/agent/browser/registry.js'
import { createBuiltInRegistry, createSubAgentRegistry } from '../src/agent/sub-agents/registry.js'

describe('buildBrowserServerConfig', () => {
  it('defaults to npx @playwright/mcp on the chrome channel, headed', () => {
    const c = buildBrowserServerConfig({}) as { command: string; args: string[] }
    // command differs by platform (cmd /c on win32); the playwright args don't.
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

  it('redirects saved output off the repo via --output-dir (npx path only)', () => {
    const def = buildBrowserServerConfig({}) as { command: string; args: string[] }
    expect(def.args).toContain('--output-dir')

    // A full command override owns its argv — we do not inject --output-dir.
    const override = buildBrowserServerConfig({ command: 'my-server', args: ['--port', '7'] })
    if (!('command' in override)) throw new Error('Expected a stdio browser server config')
    expect(override.args).not.toContain('--output-dir')
  })

  it('keeps vision capabilities stable by default and supports an explicit tree-only override', () => {
    const off = buildBrowserServerConfig({ vision: false }) as { command: string; args: string[] }
    expect([off.command, ...off.args].join(' ')).not.toContain('--caps vision')

    const on = buildBrowserServerConfig({}) as { command: string; args: string[] }
    // adjacent args, surviving the cmd /c wrapper on win32
    expect([on.command, ...on.args].join(' ')).toContain('--caps vision')
  })
})

describe('browser sub-agent registration gating', () => {
  let home: string
  let prevHome: string | undefined
  beforeAll(async () => {
    // Isolate from the developer's real ~/.x-code so the custom-agent disk scan
    // and the default config gate both see an empty home.
    prevHome = process.env.X_CODE_HOME
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-browser-'))
    process.env.X_CODE_HOME = home
  })
  afterAll(async () => {
    if (prevHome === undefined) delete process.env.X_CODE_HOME
    else process.env.X_CODE_HOME = prevHome
    await fs.rm(home, { recursive: true, force: true })
  })

  it('registers the browser agent only when includeBrowser is true', async () => {
    const on = await createSubAgentRegistry({ includeBrowser: true })
    expect(on.names()).toContain('browser')

    const off = await createSubAgentRegistry({ includeBrowser: false })
    expect(off.names()).not.toContain('browser')
  })

  it('omits the browser agent by default (no config enabling it)', async () => {
    const reg = await createSubAgentRegistry()
    expect(reg.names()).not.toContain('browser')
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
