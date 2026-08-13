import { describe, expect, it } from 'vitest'

import { isSlashCommandAllowedWhileBusy } from '../src/ui/busy-command.js'

describe('busy slash command policy', () => {
  it('allows fork only when the active owner has a stable submit boundary', () => {
    expect(isSlashCommandAllowedWhileBusy('/fork', 'user', true)).toBe(true)
    expect(isSlashCommandAllowedWhileBusy('/fork', 'peer', true)).toBe(true)
    expect(isSlashCommandAllowedWhileBusy('/fork', 'goal', true)).toBe(true)
    expect(isSlashCommandAllowedWhileBusy('/fork', 'goal', false)).toBe(false)
    expect(isSlashCommandAllowedWhileBusy('/fork', 'compact', false)).toBe(false)
    expect(isSlashCommandAllowedWhileBusy('/fork', 'resume', false)).toBe(false)
    expect(isSlashCommandAllowedWhileBusy('/fork', 'clear', false)).toBe(false)
  })

  it('allows only controls that act on the running goal', () => {
    expect(isSlashCommandAllowedWhileBusy('/goal pause', 'goal', false)).toBe(true)
    expect(isSlashCommandAllowedWhileBusy('/goal cancel', 'goal', false)).toBe(true)
    expect(isSlashCommandAllowedWhileBusy('/goal steer change direction', 'goal', false)).toBe(true)
    expect(isSlashCommandAllowedWhileBusy('/goal status', 'goal', false)).toBe(false)
    expect(isSlashCommandAllowedWhileBusy('/compact', 'user', true)).toBe(false)
  })
})
