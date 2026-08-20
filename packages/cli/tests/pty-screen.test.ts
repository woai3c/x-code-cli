import { lastPromptLine } from './pty/screen.js'

describe('PTY prompt detection', () => {
  it('recognizes the legacy Windows prompt arrow inside Unicode box rails', () => {
    expect(lastPromptLine(['╭────╮', '│ >  │', '╰────╯'])).toBe('│ >  │')
  })
})
