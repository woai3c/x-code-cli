import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { McpPermissionStore, classifyDecision } from '../src/mcp/permissions.js'

function isolate(): string {
  const dir = path.join(os.tmpdir(), 'mcp-perms-test-' + Math.random().toString(36).slice(2))
  process.env.X_CODE_HOME = dir
  return dir
}

describe('McpPermissionStore', () => {
  let home: string
  beforeEach(() => {
    home = isolate()
  })
  afterEach(() => {
    delete process.env.X_CODE_HOME
  })

  it('starts empty', async () => {
    const store = new McpPermissionStore()
    expect(await store.isApproved('foo__bar')).toBe(false)
  })

  it('approves for session only without persisting', async () => {
    const store = new McpPermissionStore()
    store.approveForSession('foo__bar')
    expect(await store.isApproved('foo__bar')).toBe(true)

    // New store instance — should still be unapproved (session-only).
    const store2 = new McpPermissionStore()
    expect(await store2.isApproved('foo__bar')).toBe(false)
  })

  it('approvePermanently persists across instances', async () => {
    const store = new McpPermissionStore()
    await store.approvePermanently('foo__bar')

    const store2 = new McpPermissionStore()
    expect(await store2.isApproved('foo__bar')).toBe(true)
  })

  it('writes a 0600 file with sorted entries', async () => {
    const store = new McpPermissionStore()
    await store.approvePermanently('zeta__b')
    await store.approvePermanently('alpha__a')

    const filePath = path.join(home, 'mcp-permissions.json')
    const raw = await fs.readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as { alwaysAllow: string[] }
    expect(parsed.alwaysAllow).toEqual(['alpha__a', 'zeta__b'])
  })

  it('ignores re-approving an already-permanent entry', async () => {
    const store = new McpPermissionStore()
    await store.approvePermanently('foo__bar')
    await store.approvePermanently('foo__bar')
    expect(await store.isApproved('foo__bar')).toBe(true)
  })

  it('migrates legacy mcp__-prefixed entries on read', async () => {
    // Simulate a permissions.json written by an earlier version, which
    // saved names as `mcp__<server>__<tool>`. The prefix is stripped at
    // load time so users keep their always-allow grants after the
    // rename to plain `<server>__<tool>`.
    const filePath = path.join(home, 'mcp-permissions.json')
    await fs.mkdir(home, { recursive: true })
    await fs.writeFile(
      filePath,
      JSON.stringify({ alwaysAllow: ['mcp__fs__read_file', 'mcp__sentry__find_issues'] }),
      'utf-8',
    )
    const store = new McpPermissionStore()
    expect(await store.isApproved('fs__read_file')).toBe(true)
    expect(await store.isApproved('sentry__find_issues')).toBe(true)
    // The old prefixed names should NOT match — migration is one-way.
    expect(await store.isApproved('mcp__fs__read_file')).toBe(false)
  })
})

describe('classifyDecision', () => {
  it('maps callback strings to structured choices', () => {
    expect(classifyDecision('yes')).toBe('allow-once')
    expect(classifyDecision('always')).toBe('allow-always')
    expect(classifyDecision('no')).toBe('deny')
  })
})
