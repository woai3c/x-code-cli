// Tests for permission system

import { describe, it, expect, vi } from 'vitest'

import { getPermissionLevel, checkPermission } from '../src/permissions/index.js'

describe('getPermissionLevel', () => {
  it('returns always-allow for read-only tools', () => {
    expect(getPermissionLevel('readFile', {})).toBe('always-allow')
    expect(getPermissionLevel('glob', {})).toBe('always-allow')
    expect(getPermissionLevel('grep', {})).toBe('always-allow')
    expect(getPermissionLevel('listDir', {})).toBe('always-allow')
    expect(getPermissionLevel('webSearch', {})).toBe('always-allow')
    expect(getPermissionLevel('webFetch', {})).toBe('always-allow')
  })

  it('returns ask for write tools', () => {
    expect(getPermissionLevel('edit', {})).toBe('ask')
    expect(getPermissionLevel('writeFile', {})).toBe('ask')
  })

  it('returns always-allow for plan mode tools', () => {
    expect(getPermissionLevel('enterPlanMode', {})).toBe('always-allow')
    expect(getPermissionLevel('exitPlanMode', {})).toBe('always-allow')
  })

  it('returns ask for unknown tools', () => {
    expect(getPermissionLevel('unknownTool', {})).toBe('ask')
  })

  it('returns always-allow for read-only shell commands', () => {
    expect(getPermissionLevel('shell', { command: 'ls -la' })).toBe('always-allow')
    expect(getPermissionLevel('shell', { command: 'pwd' })).toBe('always-allow')
    expect(getPermissionLevel('shell', { command: 'cat file.txt' })).toBe('always-allow')
    expect(getPermissionLevel('shell', { command: 'git status' })).toBe('always-allow')
    expect(getPermissionLevel('shell', { command: 'git log --oneline' })).toBe('always-allow')
  })

  it('returns ask for write shell commands', () => {
    expect(getPermissionLevel('shell', { command: 'npm install' })).toBe('ask')
    expect(getPermissionLevel('shell', { command: 'mkdir test' })).toBe('ask')
    expect(getPermissionLevel('shell', { command: 'touch file.txt' })).toBe('ask')
  })

  it('returns deny for destructive shell commands', () => {
    expect(getPermissionLevel('shell', { command: 'rm -rf /' })).toBe('deny')
    expect(getPermissionLevel('shell', { command: 'sudo rm file' })).toBe('deny')
  })

  it('handles compound commands — all read-only', () => {
    expect(getPermissionLevel('shell', { command: 'ls -la | wc -l' })).toBe('always-allow')
    expect(getPermissionLevel('shell', { command: 'git status && git log' })).toBe('always-allow')
  })

  it('handles compound commands — mixed', () => {
    expect(getPermissionLevel('shell', { command: 'ls && npm install' })).toBe('ask')
  })

  it('handles compound commands — destructive', () => {
    expect(getPermissionLevel('shell', { command: 'ls && rm -rf /' })).toBe('deny')
  })
})

describe('checkPermission', () => {
  it('returns true for always-allow tools without asking', async () => {
    const askFn = vi.fn()
    const result = await checkPermission({ toolName: 'readFile', input: {} }, false, askFn)
    expect(result).toBe(true)
    expect(askFn).not.toHaveBeenCalled()
  })

  it('returns false for denied tools without asking', async () => {
    const askFn = vi.fn()
    const result = await checkPermission(
      { toolName: 'shell', input: { command: 'rm -rf /' } },
      false,
      askFn,
    )
    expect(result).toBe(false)
    expect(askFn).not.toHaveBeenCalled()
  })

  it('asks user for ask-level tools', async () => {
    const askFn = vi.fn().mockResolvedValue(true)
    const result = await checkPermission({ toolName: 'writeFile', input: {} }, false, askFn)
    expect(result).toBe(true)
    expect(askFn).toHaveBeenCalled()
  })

  it('auto-approves ask-level tools in trust mode', async () => {
    const askFn = vi.fn()
    const result = await checkPermission({ toolName: 'writeFile', input: {} }, true, askFn)
    expect(result).toBe(true)
    expect(askFn).not.toHaveBeenCalled()
  })

  it('user can deny an ask-level tool', async () => {
    const askFn = vi.fn().mockResolvedValue(false)
    const result = await checkPermission({ toolName: 'edit', input: {} }, false, askFn)
    expect(result).toBe(false)
    expect(askFn).toHaveBeenCalled()
  })
})
