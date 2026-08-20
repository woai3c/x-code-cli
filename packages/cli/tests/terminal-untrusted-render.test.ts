import { ansiTextToCells, renderRowToAnsi, textToCells } from '../src/ui/chat-input/cells.js'
import { renderMarkdown } from '../src/ui/render/render-markdown.js'
import { resetScrollbackSpacing, writeMessageToStdout } from '../src/ui/render/stdout-writer.js'

describe('untrusted terminal rendering', () => {
  beforeEach(() => resetScrollbackSpacing())

  it('removes terminal instructions from ordinary markdown content', () => {
    const rendered = renderMarkdown('hello\x1b]52;c;c2VjcmV0\x07 world\x1b[2J')

    expect(rendered).toContain('hello world')
    expect(rendered).not.toContain('\x1b]52')
    expect(rendered).not.toContain('\x1b[2J')
    expect(rendered).not.toContain('\x07')
  })

  it('emits OSC 8 only for http and https links', () => {
    expect(renderMarkdown('[safe](https://example.com)')).toContain('\x1b]8;;https://example.com')
    expect(renderMarkdown('[unsafe](javascript:alert(1))')).not.toContain('\x1b]8;;')
  })

  it('keeps raw controls out of both plain and ANSI cell builders', () => {
    const raw = 'x\x1b]0;spoofed\x07y\x1b[2Jz'
    const plain = renderRowToAnsi(textToCells(raw, '\x1b[0m'))
    const ansi = renderRowToAnsi(ansiTextToCells(raw))

    for (const rendered of [plain, ansi]) {
      expect(rendered).not.toContain('\x1b]0;')
      expect(rendered).not.toContain('\x1b[2J')
      expect(rendered).not.toContain('\x07')
    }
  })

  it('sanitizes ordinary assistant scrollback before renderer styling', () => {
    let output = ''
    writeMessageToStdout(
      (chunk) => {
        output += chunk
      },
      {
        id: 'assistant-injection',
        role: 'assistant',
        content: 'answer\x1b]52;c;c2VjcmV0\x07 safe',
        timestamp: 0,
      },
    )

    expect(output).toContain('answer safe')
    expect(output).not.toContain('\x1b]52')
    expect(output).not.toContain('\x07')
  })
})
