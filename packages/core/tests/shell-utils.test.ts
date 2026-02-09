// Tests for shell utility functions
import { describe, expect, it } from 'vitest'

import { getShellConfig, isDestructive, isReadOnly, splitShellCommands } from '../src/tools/shell-utils.js'

describe('getShellConfig', () => {
  it('returns a valid shell config', () => {
    const config = getShellConfig()
    expect(config).toHaveProperty('executable')
    expect(config).toHaveProperty('args')
    expect(config).toHaveProperty('type')
    expect(['bash', 'zsh', 'powershell']).toContain(config.type)
  })
})

describe('splitShellCommands', () => {
  it('handles a single command', () => {
    expect(splitShellCommands('ls -la')).toEqual(['ls -la'])
  })

  it('splits by pipe', () => {
    expect(splitShellCommands('ls | wc -l')).toEqual(['ls', 'wc -l'])
  })

  it('splits by &&', () => {
    expect(splitShellCommands('cd /tmp && ls')).toEqual(['cd /tmp', 'ls'])
  })

  it('splits by semicolon', () => {
    expect(splitShellCommands('echo a; echo b')).toEqual(['echo a', 'echo b'])
  })

  it('splits by ||', () => {
    expect(splitShellCommands('test -f file || echo missing')).toEqual(['test -f file', 'echo missing'])
  })

  it('handles multiple operators', () => {
    expect(splitShellCommands('ls && cat file | wc -l')).toEqual(['ls', 'cat file', 'wc -l'])
  })

  it('respects single quotes', () => {
    expect(splitShellCommands("echo 'a && b'")).toEqual(["echo 'a && b'"])
  })

  it('respects double quotes', () => {
    expect(splitShellCommands('echo "a | b"')).toEqual(['echo "a | b"'])
  })

  it('handles empty command', () => {
    expect(splitShellCommands('')).toEqual([])
  })
})

describe('isReadOnly', () => {
  it('recognizes read-only commands', () => {
    expect(isReadOnly('ls -la')).toBe(true)
    expect(isReadOnly('pwd')).toBe(true)
    expect(isReadOnly('cat file.txt')).toBe(true)
    expect(isReadOnly('head -20 file')).toBe(true)
    expect(isReadOnly('tail -f log')).toBe(true)
    expect(isReadOnly('wc -l file')).toBe(true)
    expect(isReadOnly('echo hello')).toBe(true)
    expect(isReadOnly('which node')).toBe(true)
    expect(isReadOnly('git status')).toBe(true)
    expect(isReadOnly('git log --oneline')).toBe(true)
    expect(isReadOnly('git diff')).toBe(true)
    expect(isReadOnly('git branch')).toBe(true)
  })

  it('rejects write commands', () => {
    expect(isReadOnly('npm install')).toBe(false)
    expect(isReadOnly('mkdir foo')).toBe(false)
    expect(isReadOnly('rm file')).toBe(false)
    expect(isReadOnly('git push')).toBe(false)
    expect(isReadOnly('git commit -m "test"')).toBe(false)
  })
})

describe('isDestructive', () => {
  it('recognizes destructive commands', () => {
    expect(isDestructive('rm -rf /')).toBe(true)
    expect(isDestructive('rm --recursive --force dir')).toBe(true)
    expect(isDestructive('sudo apt install')).toBe(true)
    expect(isDestructive('mkfs /dev/sda1')).toBe(true)
    expect(isDestructive('dd if=/dev/zero of=/dev/sda')).toBe(true)
  })

  it('does not flag safe commands', () => {
    expect(isDestructive('ls -la')).toBe(false)
    expect(isDestructive('npm install')).toBe(false)
    expect(isDestructive('git push')).toBe(false)
    expect(isDestructive('rm file.txt')).toBe(false)
  })
})
