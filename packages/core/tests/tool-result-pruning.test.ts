import { describe, expect, it } from 'vitest'

import type { ModelMessage } from 'ai'

import { collapseConsumedToolResults, collapseStaleToolResults } from '../src/agent/tool-result-pruning.js'

function toolMsg(toolName: string, output: { type: string; value: unknown }): ModelMessage {
  return { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't', toolName, output }] } as ModelMessage
}
function textOut(s: string) {
  return { type: 'text', value: s }
}
function out(msg: ModelMessage) {
  return (msg.content as Array<{ output: { type: string; value: unknown } }>)[0].output
}

describe('collapseStaleToolResults', () => {
  it('keeps the latest snapshot and collapses earlier ones (suffix-matches mangled names)', () => {
    const messages = [
      toolMsg('browser__browser_snapshot', textOut('OLD TREE 1')),
      { role: 'assistant', content: 'thinking' } as ModelMessage,
      toolMsg('browser__browser_snapshot', textOut('OLD TREE 2')),
      toolMsg('browser__browser_snapshot', textOut('LATEST TREE')),
    ]
    collapseStaleToolResults(messages, ['browser_snapshot'])

    expect((out(messages[0]).value as string).startsWith('[Older browser_snapshot')).toBe(true)
    expect((out(messages[2]).value as string).startsWith('[Older browser_snapshot')).toBe(true)
    expect(out(messages[3]).value).toBe('LATEST TREE') // newest untouched
  })

  it('collapses an older screenshot (content+media) to a text placeholder', () => {
    const messages = [
      toolMsg('browser__browser_take_screenshot', {
        type: 'content',
        value: [
          { type: 'text', text: '[image returned]' },
          { type: 'media', data: 'AAAA', mediaType: 'image/png' },
        ],
      }),
      toolMsg('browser__browser_take_screenshot', {
        type: 'content',
        value: [{ type: 'media', data: 'BBBB', mediaType: 'image/png' }],
      }),
    ]
    collapseStaleToolResults(messages, ['browser_take_screenshot'])

    // old image is gone, replaced by text; latest still carries its media
    expect(out(messages[0]).type).toBe('text')
    expect(out(messages[1]).type).toBe('content')
  })

  it('is idempotent — a second pass changes nothing', () => {
    const messages = [
      toolMsg('browser__browser_snapshot', textOut('OLD')),
      toolMsg('browser__browser_snapshot', textOut('NEW')),
    ]
    collapseStaleToolResults(messages, ['browser_snapshot'])
    const afterFirst = out(messages[0]).value
    collapseStaleToolResults(messages, ['browser_snapshot'])
    expect(out(messages[0]).value).toBe(afterFirst)
    expect(out(messages[1]).value).toBe('NEW')
  })

  it('leaves unrelated tool results and other suffixes alone', () => {
    const messages = [
      toolMsg('browser__browser_snapshot', textOut('TREE A')),
      toolMsg('readFile_1', textOut('file contents')),
      toolMsg('browser__browser_snapshot', textOut('TREE B')),
    ]
    collapseStaleToolResults(messages, ['browser_snapshot'])
    expect(out(messages[1]).value).toBe('file contents') // untouched
  })

  it('no-ops on an empty suffix list', () => {
    const messages = [
      toolMsg('browser__browser_snapshot', textOut('A')),
      toolMsg('browser__browser_snapshot', textOut('B')),
    ]
    collapseStaleToolResults(messages, [])
    expect(out(messages[0]).value).toBe('A')
  })
})

describe('collapseConsumedToolResults', () => {
  it('keeps a screenshot intact until a following assistant message has consumed it', () => {
    const pending = [
      { role: 'assistant', content: 'calling visual check' } as ModelMessage,
      toolMsg('browserVisualCheck', {
        type: 'content',
        value: [{ type: 'media', data: 'AAAA', mediaType: 'image/jpeg' }],
      }),
    ]
    collapseConsumedToolResults(pending, ['browserVisualCheck'])
    expect(out(pending[1]).type).toBe('content')

    pending.push({ role: 'assistant', content: 'The layout looks correct.' } as ModelMessage)
    collapseConsumedToolResults(pending, ['browserVisualCheck'])
    expect(out(pending[1]).type).toBe('text')
    expect(out(pending[1]).value).toContain('Consumed browserVisualCheck')
  })

  it('does not collapse unrelated image tools', () => {
    const messages = [
      toolMsg('readFile', textOut('file contents')),
      { role: 'assistant', content: 'done' } as ModelMessage,
    ]
    collapseConsumedToolResults(messages, ['browserVisualCheck'])
    expect(out(messages[0]).value).toBe('file contents')
  })
})
