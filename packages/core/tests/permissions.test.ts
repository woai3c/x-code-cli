// Tests for permission system
import { describe, expect, it, vi } from 'vitest'

import { checkPermission, getPermissionLevel, isPathWithinProject } from '../src/permissions/index.js'
import { buildAllowRule, extractCommandPrefix, suggestRuleLabel } from '../src/permissions/session-store.js'

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
    const result = await checkPermission(
      { toolCallId: '2', toolName: 'shell', input: { command: 'rm -rf /' } },
      false,
      askFn,
    )
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
      false,
      askFn,
      'acceptEdits',
      cwd,
    )
    expect(result).toBe(true)
    expect(askFn).not.toHaveBeenCalled()
  })

  it('acceptEdits blocks writes outside project dir — falls to ask', async () => {
    const askFn = vi.fn().mockResolvedValue('no')
    const cwd = process.cwd()
    const result = await checkPermission(
      { toolCallId: '11', toolName: 'writeFile', input: { filePath: '/etc/passwd' } },
      false,
      askFn,
      'acceptEdits',
      cwd,
    )
    expect(result).toBe(false)
    expect(askFn).toHaveBeenCalled()
  })

  it('acceptEdits blocks writes to sensitive dotfiles — falls to ask', async () => {
    const askFn = vi.fn().mockResolvedValue('no')
    const cwd = process.cwd()
    const result = await checkPermission(
      { toolCallId: '12', toolName: 'edit', input: { filePath: `${cwd}/.env` } },
      false,
      askFn,
      'acceptEdits',
      cwd,
    )
    expect(result).toBe(false)
    expect(askFn).toHaveBeenCalled()
  })

  it('acceptEdits blocks writes to .git directory — falls to ask', async () => {
    const askFn = vi.fn().mockResolvedValue('no')
    const cwd = process.cwd()
    const result = await checkPermission(
      { toolCallId: '13', toolName: 'writeFile', input: { filePath: `${cwd}/.git/config` } },
      false,
      askFn,
      'acceptEdits',
      cwd,
    )
    expect(result).toBe(false)
    expect(askFn).toHaveBeenCalled()
  })

  it('acceptEdits blocks path traversal via ../ — falls to ask', async () => {
    const askFn = vi.fn().mockResolvedValue('no')
    const cwd = process.cwd()
    const result = await checkPermission(
      { toolCallId: '14', toolName: 'writeFile', input: { filePath: `${cwd}/../../etc/passwd` } },
      false,
      askFn,
      'acceptEdits',
      cwd,
    )
    expect(result).toBe(false)
    expect(askFn).toHaveBeenCalled()
  })
})

describe('extractCommandPrefix', () => {
  it('extracts two-token prefix for plain commands', () => {
    expect(extractCommandPrefix('git commit -m "fix"')).toBe('git commit')
    expect(extractCommandPrefix('pnpm run build')).toBe('pnpm run')
    expect(extractCommandPrefix('npm install lodash')).toBe('npm install')
  })

  it('strips env-var prefixes', () => {
    expect(extractCommandPrefix('NODE_ENV=prod npm run dev')).toBe('npm run')
    expect(extractCommandPrefix('FOO=1 BAR=2 git status')).toBe('git status')
  })

  it('returns null for single-token or unprefixable commands', () => {
    expect(extractCommandPrefix('')).toBeNull()
    expect(extractCommandPrefix('ls')).toBeNull()
    expect(extractCommandPrefix('ls -la')).toBeNull()
  })

  it('extracts cmdlet from quoted powershell -Command form', () => {
    expect(extractCommandPrefix('powershell -Command "Get-CimInstance Win32_LogicalDisk"')).toBe('Get-CimInstance')
    expect(extractCommandPrefix('powershell -c "Get-Process"')).toBe('Get-Process')
    expect(extractCommandPrefix('powershell.exe -Command "Get-Date"')).toBe('Get-Date')
  })

  it('handles powershell with leading flags before -Command', () => {
    // Real failure case from a.log: `-NoProfile` between launcher and `-Command`
    // hid the "don't ask again" option for every sub-agent shell call.
    expect(extractCommandPrefix('powershell -NoProfile -Command "Get-CimInstance Win32_LogicalDisk"')).toBe(
      'Get-CimInstance',
    )
    expect(extractCommandPrefix('powershell -ExecutionPolicy Bypass -Command "git status"')).toBe('git')
    expect(extractCommandPrefix('powershell -NoLogo -NonInteractive -Command "Get-Process"')).toBe('Get-Process')
    expect(extractCommandPrefix('powershell -NoProfile -ExecutionPolicy Bypass -c "Get-CimInstance"')).toBe(
      'Get-CimInstance',
    )
  })

  it('handles unquoted powershell command argument', () => {
    expect(extractCommandPrefix('powershell -Command Get-Date')).toBe('Get-Date')
    expect(extractCommandPrefix('powershell -NoProfile -Command Get-Process')).toBe('Get-Process')
  })

  it('handles powershell call-operator wrapping', () => {
    expect(extractCommandPrefix('powershell -Command "& { Get-Process }"')).toBe('Get-Process')
    expect(extractCommandPrefix('powershell -NoProfile -Command "& { Get-CimInstance Win32_LogicalDisk }"')).toBe(
      'Get-CimInstance',
    )
  })

  it('handles pwsh launcher', () => {
    expect(extractCommandPrefix('pwsh -Command "Get-Process"')).toBe('Get-Process')
    expect(extractCommandPrefix('pwsh.exe -NoProfile -Command "git status"')).toBe('git')
  })

  it('returns null for powershell -File (no derivable command name)', () => {
    expect(extractCommandPrefix('powershell -File ./script.ps1')).toBeNull()
    expect(extractCommandPrefix('powershell -NoProfile -File foo.ps1 arg1')).toBeNull()
  })

  it('returns null when powershell has only flags (no command)', () => {
    expect(extractCommandPrefix('powershell -NoProfile -ExecutionPolicy Bypass')).toBeNull()
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

describe('suggestRuleLabel + buildAllowRule fallback for unrecognised shell commands', () => {
  it('offers an exact-match label for Windows commands with /flag second token', () => {
    // Real failure case: `findstr /n "any\b" "..." 2>nul` got Yes/No with
    // no "don't ask again" because `/n` failed the prefix regex. The
    // exact-match fallback gives the user a way out.
    const input = { command: 'findstr /n "any\\b" "D:\\res\\file.ts" 2>nul' }
    expect(suggestRuleLabel('shell', input)).toBe('this exact command')
    const built = buildAllowRule('shell', input)
    expect(built).not.toBeNull()
    expect(built!.persist).toBe(true)
    expect(built!.rule.type).toBe('exact')
    expect(built!.rule.pattern).toBe(input.command)
  })

  it('still prefers the prefix rule when one is derivable', () => {
    expect(suggestRuleLabel('shell', { command: 'git commit -m fix' })).toBe('git commit:*')
    const built = buildAllowRule('shell', { command: 'git commit -m fix' })
    expect(built!.rule.type).toBe('prefix')
    expect(built!.rule.pattern).toBe('git commit')
  })

  it('strips env-var prefixes before storing the exact-match pattern', () => {
    // `NODE_ENV=prod` is a SAFE env-var prefix; the matcher compares
    // against `stripEnvVars(cmd)`, so we must store the same stripped
    // shape in the rule pattern.
    const built = buildAllowRule('shell', { command: 'NODE_ENV=prod findstr /v foo bar.txt' })
    expect(built!.rule.type).toBe('exact')
    expect(built!.rule.pattern).toBe('findstr /v foo bar.txt')
  })

  it('returns null label/rule for empty shell command', () => {
    expect(suggestRuleLabel('shell', { command: '' })).toBe('this exact command')
    // buildAllowRule still bails on a fully empty command after stripping.
    expect(buildAllowRule('shell', { command: '' })).toBeNull()
  })

  it('keeps writeFile/edit on session-only tool-wide rules', () => {
    expect(suggestRuleLabel('writeFile', {})).toBe('all edits this session')
    const built = buildAllowRule('writeFile', {})
    expect(built!.rule.type).toBe('tool')
    expect(built!.persist).toBe(false)
  })

  it('returns null for enterPlanMode (no recurring action to remember)', () => {
    expect(suggestRuleLabel('enterPlanMode', {})).toBeNull()
  })
})
