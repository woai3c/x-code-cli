import { countContentRows } from '../src/ui/chat-input/text-helpers.js'
import { renderMarkdown } from '../src/ui/render/render-markdown.js'
import { resetScrollbackSpacing, writeMessageToStdout } from '../src/ui/render/stdout-writer.js'
import { charWidth, graphemes, visualWidth } from '../src/ui/render/text-width.js'

const { originalNoColor } = vi.hoisted(() => {
  const originalNoColor = process.env.NO_COLOR
  delete process.env.NO_COLOR
  return { originalNoColor }
})

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])/g
const stripAnsi = (s: string): string => s.replace(ANSI_RE, '')

function tableLines(rendered: string): string[] {
  return stripAnsi(rendered)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => line.length > 0)
}

function borderColumnPositions(plainLine: string): number[] {
  const positions: number[] = []
  let col = 0
  for (const g of graphemes(plainLine)) {
    if ('┌┬┐├┼┤└┴┘│'.includes(g)) {
      positions.push(col)
    }
    col += charWidth(g)
  }
  return positions
}

describe('markdown table width-aware wrapping', () => {
  afterAll(() => {
    if (originalNoColor === undefined) delete process.env.NO_COLOR
    else process.env.NO_COLOR = originalNoColor
  })

  beforeEach(() => {
    resetScrollbackSpacing()
  })

  it('keeps natural single-line layout when terminal width is wide enough', () => {
    const md = [
      '| Name | Type | Default |',
      '| --- | --- | --- |',
      '| timeout | number | 10000 |',
      '| cwd | string | project root |',
    ].join('\n')

    const lines = tableLines(renderMarkdown(md, 100))
    expect(lines).toEqual([
      '┌─────────┬────────┬──────────────┐',
      '│ Name    │ Type   │ Default      │',
      '├─────────┼────────┼──────────────┤',
      '│ timeout │ number │ 10000        │',
      '│ cwd     │ string │ project root │',
      '└─────────┴────────┴──────────────┘',
    ])
  })

  it('wraps CJK and mixed text inside table cells on narrow terminals while keeping all borders aligned', () => {
    const md = [
      '| 参数 | 类型 | 说明 |',
      '| --- | --- | --- |',
      '| `timeout` | `number` | 命令超时时间（毫秒），超时后自动终止子进程并返回超时错误 |',
      '| `cwd` | `string` | 执行命令所在的工作目录路径，默认使用当前项目根目录 |',
    ].join('\n')

    const maxWidth = 46
    const rendered = renderMarkdown(md, maxWidth)
    const lines = tableLines(rendered)

    // Still a multi-column box-drawing table, wrapped across multiple lines.
    expect(lines[0]!.startsWith('┌')).toBe(true)
    expect(lines[0]!.endsWith('┐')).toBe(true)
    expect(lines[lines.length - 1]!.startsWith('└')).toBe(true)
    expect(lines[lines.length - 1]!.endsWith('┘')).toBe(true)
    expect(lines.length).toBeGreaterThan(8)

    const expectedWidth = visualWidth(lines[0]!)
    expect(expectedWidth).toBeLessThanOrEqual(maxWidth)

    const expectedCols = borderColumnPositions(lines[0]!)
    expect(expectedCols.length).toBe(4) // 3 columns => 4 vertical border positions

    for (const line of lines) {
      expect(visualWidth(line)).toBe(expectedWidth)
      expect(borderColumnPositions(line)).toEqual(expectedCols)
    }

    // Compact columns (`timeout`, `number`) stay unsplit while description wraps.
    const fullPlain = lines.join('\n')
    expect(fullPlain).toContain('│ timeout │ number │')
    expect(fullPlain).toContain('│ cwd     │ string │')
    expect(fullPlain).toContain('自动终止子进程')
    expect(fullPlain).toContain('默认使用当前')
  })

  it('closes and reopens inline ANSI styles and OSC 8 hyperlinks across wrapped cell lines without bleeding into borders', () => {
    const md = [
      '| Item | Documentation |',
      '| --- | --- |',
      '| `very_long_inline_code_token` | Visit [official guide documentation](https://example.com/docs) now |',
    ].join('\n')

    const rendered = renderMarkdown(md, 42)
    const rawLines = rendered.trimEnd().split('\n')
    const plainLines = rawLines.map(stripAnsi)

    const width0 = visualWidth(plainLines[0]!)
    expect(width0).toBeLessThanOrEqual(42)
    for (const pl of plainLines) {
      expect(visualWidth(pl)).toBe(width0)
    }

    // Both wrapped halves of the link carry their own self-contained OSC 8 sequences,
    // and no raw line leaves an unclosed OSC 8 hyperlink open across `│` borders.
    const linkLines = rawLines.filter((l) => l.includes('\x1b]8;;https://example.com/docs\x1b\\'))
    expect(linkLines.length).toBeGreaterThanOrEqual(2)
    for (const l of linkLines) {
      const opens = l.split('\x1b]8;;https://example.com/docs\x1b\\').length - 1
      const closes = l.split('\x1b]8;;\x1b\\').length - 1
      expect(closes).toBe(opens)
    }
  })

  it('breaks long file paths at path delimiters and supports <br> and escaped pipes inside cells', () => {
    const md = [
      '| File | Notes |',
      '| --- | :--- |',
      '| `packages/cli/src/ui/render/render-markdown.ts` | first line<br>a \\| b |',
    ].join('\n')

    const lines = tableLines(renderMarkdown(md, 44))
    const width0 = visualWidth(lines[0]!)
    expect(width0).toBeLessThanOrEqual(44)
    const cols0 = borderColumnPositions(lines[0]!)

    for (const line of lines) {
      expect(visualWidth(line)).toBe(width0)
      expect(borderColumnPositions(line)).toEqual(cols0)
    }

    const joined = lines.join('\n')
    expect(joined).toContain('first line')
    expect(joined).toContain('a | b')
    expect(joined).toContain('render-markdown.ts')
  })

  it('normalizes ragged rows and supports column alignments across wrapped lines', () => {
    const md = [
      '| Key | Count | Label |',
      '| :--- | ---: | :---: |',
      '| alpha | 42 | centered header and text |',
      '| sparse-row-only-one-cell |',
    ].join('\n')

    const lines = tableLines(renderMarkdown(md, 38))
    const width0 = visualWidth(lines[0]!)
    const cols0 = borderColumnPositions(lines[0]!)
    expect(width0).toBeLessThanOrEqual(38)

    for (const line of lines) {
      expect(visualWidth(line)).toBe(width0)
      expect(borderColumnPositions(line)).toEqual(cols0)
    }
    expect(lines.some((l) => l.includes('42 │'))).toBe(true)
  })

  it('falls back cleanly to boxed vertical cards when column count physically exceeds terminal width', () => {
    const md = [
      '| C1 | C2 | C3 | C4 | C5 | C6 | C7 | C8 |',
      '| --- | --- | --- | --- | --- | --- | --- | --- |',
      '| v1 | v2 | v3 | v4 | v5 | v6 | v7 | v8 |',
    ].join('\n')

    const lines = tableLines(renderMarkdown(md, 20))
    expect(lines[0]!.startsWith('┌')).toBe(true)
    expect(lines[lines.length - 1]!.startsWith('└')).toBe(true)
    for (const line of lines) {
      expect(visualWidth(line)).toBeLessThanOrEqual(20)
    }
    expect(lines.join('\n')).toContain('C1: v1')
    expect(lines.join('\n')).toContain('C8: v8')
  })

  it('fits assistant scrollback tables within terminal width and matches countContentRows exactly', () => {
    const cols = 56
    const md = [
      '| 模块 | 当前行为 | 修复后行为 |',
      '| --- | --- | --- |',
      '| Markdown 表格 | 终端较窄时按原始最大宽度输出，导致边框被终端硬折行错位 | 按终端可用宽度分配列宽并在单元格内自动换行，保持表格结构完整 |',
      '| CJK 文本 | 宽字符与窄字符混排容易越界 | 统一使用视觉宽度计算与分词换行 |',
    ].join('\n')

    let out = ''
    writeMessageToStdout(
      (chunk) => {
        out += chunk
      },
      { id: 'a1', role: 'assistant', content: md, timestamp: 0 },
      cols,
    )

    const rawRows = stripAnsi(out).replace(/\r\n/g, '\n').split('\n')
    if (rawRows.length > 0 && rawRows[rawRows.length - 1] === '') rawRows.pop()

    const tableRows = rawRows.filter((r) => /[┌┐├┤└┘│]/.test(r))
    expect(tableRows.length).toBeGreaterThan(8)
    for (const row of tableRows) {
      // 2-space assistant indent + table width stays strictly within cols - 1
      expect(row.startsWith('  ')).toBe(true)
      expect(visualWidth(row)).toBeLessThanOrEqual(cols - 1)
    }
    // No phantom trailing space row after the closing table border, and
    // scrollback row accounting matches physical rows 1:1.
    expect(countContentRows(out, cols)).toBe(rawRows.length)
  })

  it('still parses markdown tables that appear after >500 chars of plain prose', () => {
    const intro = '这是一段超过五百字的前置说明文本。'.repeat(35)
    const md = `${intro}\n\n| A | B |\n| --- | --- |\n| 1 | 2 |`
    const rendered = stripAnsi(renderMarkdown(md, 60))
    expect(rendered).toContain('┌─────┬─────┐')
    expect(rendered).toContain('└─────┴─────┘')
  })

  it('extracts trailing non-pipe spillover prose below the table instead of stuffing it into column 0', () => {
    const md = [
      '| ID | 名称 |',
      '| --- | --- |',
      '| 1 | 正常行 |',
      '注：模型漏写了空行紧跟的说明文字不应进入表格第一列。',
    ].join('\n')

    const lines = tableLines(renderMarkdown(md, 50))
    const bottomIdx = lines.findIndex((l) => l.startsWith('└'))
    expect(bottomIdx).toBeGreaterThan(0)
    // Column 0 stays narrow (`ID` / `1` => 3 cells + 2 pad = 5 dashes)
    expect(lines[0]!.startsWith('┌─────┬')).toBe(true)
    // Spillover prose renders cleanly AFTER the closing table border
    expect(lines.slice(bottomIdx + 1).join('\n')).toContain('注：模型漏写了空行')
  })

  it('keeps every row of a nested list-item table aligned at the same indentation', () => {
    const md = [
      '- 外层列表',
      '  - 内层说明',
      '',
      '    | 列一 | 列二 |',
      '    | --- | --- |',
      '    | 值一 | 值二 |',
    ].join('\n')
    const lines = tableLines(renderMarkdown(md, 50)).filter((l) => /[┌├└│]/.test(l))
    expect(lines.length).toBe(5)
    for (const line of lines) {
      expect(line.startsWith('  ')).toBe(true)
      expect(visualWidth(line)).toBeLessThanOrEqual(50)
    }
  })

  it('never overflows terminal width when appending tool duration after a full-width table summary', () => {
    const cols = 52
    const tableOutput = [
      '| 参数 | 详细描述 |',
      '| --- | --- |',
      '| `timeout` | 控制子进程最长等待毫秒数并在超时后安全回收进程树 |',
    ].join('\n')

    let out = ''
    writeMessageToStdout(
      (chunk) => {
        out += chunk
      },
      {
        id: 'tc-msg',
        role: 'assistant',
        content: '',
        timestamp: 0,
        toolCalls: [
          {
            id: 'tc-1',
            toolName: 'mcp__docs__query',
            input: { q: 'timeout' },
            output: tableOutput,
            status: 'completed',
            durationMs: 1200,
          },
        ],
      },
      cols,
    )

    const rows = stripAnsi(out).replace(/\r\n/g, '\n').split('\n')
    if (rows.length > 0 && rows[rows.length - 1] === '') rows.pop()
    for (const row of rows) {
      expect(visualWidth(row)).toBeLessThanOrEqual(cols - 1)
    }
    expect(countContentRows(out, cols)).toBe(rows.length)
  })
})
