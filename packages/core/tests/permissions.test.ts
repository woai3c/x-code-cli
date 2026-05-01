// Tests for permission system
import { describe, expect, it, vi } from 'vitest'

import { checkPermission, getPermissionLevel, isPathWithinProject } from '../src/permissions/index.js'

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
    const result = await checkPermission({ toolCallId: '1', toolName: 'readFile', input: {} }, false, askFn)
    expect(result).toBe(true)
    expect(askFn).not.toHaveBeenCalled()
  })

  it('returns false for denied tools without asking', async () => {
    const askFn = vi.fn()
    const result = await checkPermission({ toolCallId: '2', toolName: 'shell', input: { command: 'rm -rf /' } }, false, askFn)
    expect(result).toBe(false)
    expect(askFn).not.toHaveBeenCalled()
  })

  it('asks user for ask-level tools', async () => {
    const askFn = vi.fn().mockResolvedValue('yes')
    const result = await checkPermission({ toolCallId: '3', toolName: 'writeFile', input: {} }, false, askFn)
    expect(result).toBe(true)
    expect(askFn).toHaveBeenCalled()
  })

  it('auto-approves ask-level tools in trust mode', async () => {
    const askFn = vi.fn()
    const result = await checkPermission({ toolCallId: '4', toolName: 'writeFile', input: {} }, true, askFn)
    expect(result).toBe(true)
    expect(askFn).not.toHaveBeenCalled()
  })

  it('user can deny an ask-level tool', async () => {
    const askFn = vi.fn().mockResolvedValue('no')
    const result = await checkPermission({ toolCallId: '5', toolName: 'edit', input: {} }, false, askFn)
    expect(result).toBe(false)
    expect(askFn).toHaveBeenCalled()
  })

  it('acceptEdits auto-approves writes inside project dir', async () => {
    const askFn = vi.fn()
    const cwd = process.cwd()
    const result = await checkPermission(
      { toolCallId: '10', toolName: 'writeFile', input: { filePath: `${cwd}/src/foo.ts` } },
      false, askFn, 'acceptEdits', cwd,
    )
    expect(result).toBe(true)
    expect(askFn).not.toHaveBeenCalled()
  })

  it('acceptEdits blocks writes outside project dir — falls to ask', async () => {
    const askFn = vi.fn().mockResolvedValue('no')
    const cwd = process.cwd()
    const result = await checkPermission(
      { toolCallId: '11', toolName: 'writeFile', input: { filePath: '/etc/passwd' } },
      false, askFn, 'acceptEdits', cwd,
    )
    expect(result).toBe(false)
    expect(askFn).toHaveBeenCalled()
  })

  it('acceptEdits blocks writes to sensitive dotfiles — falls to ask', async () => {
    const askFn = vi.fn().mockResolvedValue('no')
    const cwd = process.cwd()
    const result = await checkPermission(
      { toolCallId: '12', toolName: 'edit', input: { filePath: `${cwd}/.env` } },
      false, askFn, 'acceptEdits', cwd,
    )
    expect(result).toBe(false)
    expect(askFn).toHaveBeenCalled()
  })

  it('acceptEdits blocks writes to .git directory — falls to ask', async () => {
    const askFn = vi.fn().mockResolvedValue('no')
    const cwd = process.cwd()
    const result = await checkPermission(
      { toolCallId: '13', toolName: 'writeFile', input: { filePath: `${cwd}/.git/config` } },
      false, askFn, 'acceptEdits', cwd,
    )
    expect(result).toBe(false)
    expect(askFn).toHaveBeenCalled()
  })

  it('acceptEdits blocks path traversal via ../ — falls to ask', async () => {
    const askFn = vi.fn().mockResolvedValue('no')
    const cwd = process.cwd()
    const result = await checkPermission(
      { toolCallId: '14', toolName: 'writeFile', input: { filePath: `${cwd}/../../etc/passwd` } },
      false, askFn, 'acceptEdits', cwd,
    )
    expect(result).toBe(false)
    expect(askFn).toHaveBeenCalled()
  })
})

describe('isPathWithinProject', () => {
  const cwd = process.cwd()

  it('returns true for paths inside the project', () => {
    expect(isPathWithinProject(`${cwd}/src/index.ts`, cwd)).toBe(true)
    expect(isPathWithinProject(`${cwd}/deep/nested/file.ts`, cwd)).toBe(true)
  })

  it('returns true when file path equals project dir', () => {
    expect(isPathWithinProject(cwd, cwd)).toBe(true)
  })

  it('returns false for paths outside the project', () => {
    expect(isPathWithinProject('/etc/passwd', cwd)).toBe(false)
    expect(isPathWithinProject('/tmp/evil.ts', cwd)).toBe(false)
  })

  it('returns false for traversal attacks', () => {
    expect(isPathWithinProject(`${cwd}/../../etc/passwd`, cwd)).toBe(false)
    expect(isPathWithinProject(`${cwd}/../secret`, cwd)).toBe(false)
  })
})
