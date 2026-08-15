import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { persistRule, readPersistedRules } from '../src/permissions/persistence.js'
import { clearSessionRules, loadPersistedRules, sessionRulesMatch } from '../src/permissions/session-store.js'

describe('permission persistence', () => {
  let cwd: string

  beforeEach(async () => {
    clearSessionRules()
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-permissions-'))
  })

  afterEach(async () => {
    clearSessionRules()
    await fs.rm(cwd, { recursive: true, force: true })
  })

  it('appends rules, deduplicates entries, and protects the local directory', async () => {
    const rules = [
      { tool: 'shell', pattern: 'git commit', type: 'prefix' as const },
      { tool: 'shell', pattern: 'git push', type: 'prefix' as const },
    ]

    persistRule(cwd, rules[0]!)
    persistRule(cwd, rules[1]!)
    persistRule(cwd, rules[0]!)

    const localDir = path.join(cwd, '.x-code', 'local')
    const data = JSON.parse(await fs.readFile(path.join(localDir, 'permissions.json'), 'utf-8')) as {
      version: number
      allow: unknown[]
    }
    expect(data).toEqual({
      version: 2,
      allow: [
        { tool: 'shell', pattern: 'git commit', type: 'prefix', cwd: path.resolve(cwd) },
        { tool: 'shell', pattern: 'git push', type: 'prefix', cwd: path.resolve(cwd) },
      ],
    })
    expect(await fs.readFile(path.join(localDir, '.gitignore'), 'utf-8')).toBe('*\n')
  })

  it('recovers from malformed data and loads only valid rules', async () => {
    const localDir = path.join(cwd, '.x-code', 'local')
    await fs.mkdir(localDir, { recursive: true })
    await fs.writeFile(path.join(localDir, 'permissions.json'), '{ malformed', 'utf-8')

    persistRule(cwd, { tool: 'shell', pattern: 'npm install', type: 'prefix' })
    const filePath = path.join(localDir, 'permissions.json')
    const data = JSON.parse(await fs.readFile(filePath, 'utf-8')) as { allow: unknown[] }
    data.allow.push('invalid', 42)
    await fs.writeFile(filePath, JSON.stringify(data), 'utf-8')

    loadPersistedRules(cwd)
    expect(sessionRulesMatch('shell', { command: 'npm install lodash' }, path.resolve(cwd))).toBe(true)
    expect(readPersistedRules(cwd)).toEqual([
      { tool: 'shell', pattern: 'npm install', type: 'prefix', cwd: path.resolve(cwd) },
    ])
  })

  it('keeps persistence synchronous and propagates write failures', async () => {
    const invalidCwd = path.join(cwd, 'not-a-directory')
    await fs.writeFile(invalidCwd, 'blocks directory creation', 'utf-8')

    expect(() => persistRule(invalidCwd, { tool: 'shell', pattern: 'git push', type: 'prefix' })).toThrow()
  })
})
