import type { DisplayMessage } from '@x-code-cli/core'

import { resetScrollbackSpacing, writeMessageToStdout } from '../src/ui/render/stdout-writer.js'

function render(message: DisplayMessage): string {
  let output = ''
  resetScrollbackSpacing()
  writeMessageToStdout((value) => (output += value), message)
  return output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '')
}

describe('peer message renderer', () => {
  it('renders a source-aware card instead of a user prompt', () => {
    const output = render({
      id: 'peer-1',
      role: 'user',
      content: '第一行 👋\nsecond line',
      timestamp: 0,
      kind: 'peer-message',
      peer: { name: 'backend', address: 'peer:00000000-0000-4000-8000-000000000001', summary: 'handoff' },
    })
    expect(output).toContain('Peer message · backend · peer:00000000-0000-4000-8000-000000000001')
    expect(output).toContain('Summary: handoff')
    expect(output).toContain('   第一行 👋\n   second line')
    expect(output).not.toContain('❯')
  })

  it('renders delivery updates as compact status lines', () => {
    const output = render({
      id: 'status-1',
      role: 'assistant',
      content: 'Message deadbeef: denied by backend.',
      timestamp: 0,
      kind: 'peer-status',
    })
    expect(output).toContain('⎿  Message deadbeef: denied by backend.')
  })
})
