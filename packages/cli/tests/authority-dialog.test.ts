import type { AuthorityApprovalPreview } from '@x-code-cli/core'

import {
  authorityMetadataLines,
  authorityPayloadLines,
  authorityViewerLines,
  authorityVisibleLines,
} from '../src/ui/chat-input/authority-display.js'

const HASH = 'a'.repeat(64)
const TERMINAL_OR_BIDI_CONTROL =
  /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u

function preview(overrides: Partial<AuthorityApprovalPreview> = {}): AuthorityApprovalPreview {
  return {
    toolName: 'shell',
    summary: 'peer request',
    complete: true,
    approvable: true,
    authorityHash: HASH,
    canonicalCallSha256: HASH,
    ...overrides,
  }
}

describe('authority dialog terminal-safe display', () => {
  it('renders payload controls as visible escapes and splits every line ending into rows', () => {
    const lines = authorityPayloadLines(
      preview({
        outboundPayload: {
          format: 'shell-command',
          canonical: 'first\r\n第二行 👋\rthird\nfourth\x1b[2J\x1b]52;c;Y2xpcGJvYXJk\x07\u009b31m\u202eend',
          byteLength: 1,
          sha256: HASH,
        },
      }),
    )

    expect(lines).toEqual([
      'first',
      '第二行 👋',
      'third',
      'fourth\\u001B[2J\\u001B]52;c;Y2xpcGJvYXJk\\u0007\\u009B31m\\u202Eend',
    ])
    expect(lines.every((line) => !TERMINAL_OR_BIDI_CONTROL.test(line))).toBe(true)
  })

  it('visibly escapes untrusted metadata without dropping OSC content or multiline paths', () => {
    const lines = authorityMetadataLines(
      preview({
        toolName: 'read\x00File',
        serverId: 'server\u009d52;c;server-secret\u009c',
        destination: 'https://evil.test\x1b]8;;https://target.test\x1b\\\u2066',
        paths: ['/repo/one\ncontinued\x07', '/repo/\u202etwo'],
      }),
    )

    expect(lines).toEqual([
      'Tool: read\\u0000File',
      'Server: server\\u009D52;c;server-secret\\u009C',
      'Destination: https://evil.test\\u001B]8;;https://target.test\\u001B\\\\u2066',
      'Paths: /repo/one',
      '       continued\\u0007, /repo/\\u202Etwo',
    ])
    expect(lines.join('\n')).toContain('server-secret')
    expect(lines.every((line) => !TERMINAL_OR_BIDI_CONTROL.test(line))).toBe(true)
  })

  it('makes all C0, C1, DEL, bidi, and unpaired surrogates terminal inert', () => {
    const unsafe =
      Array.from({ length: 0x20 }, (_, code) => String.fromCharCode(code)).join('') +
      Array.from({ length: 0x21 }, (_, offset) => String.fromCharCode(0x7f + offset)).join('') +
      '\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069\ud800'
    const lines = authorityVisibleLines(unsafe)

    expect(lines.length).toBe(3)
    expect(lines.join('')).toContain('\\u001B')
    expect(lines.join('')).toContain('\\u007F')
    expect(lines.join('')).toContain('\\u009F')
    expect(lines.join('')).toContain('\\u202E')
    expect(lines.join('')).toContain('\\uD800')
    expect(lines.every((line) => !TERMINAL_OR_BIDI_CONTROL.test(line))).toBe(true)
  })

  it('binds the display label to the original payload byte length and hash', () => {
    const value = preview({
      outboundPayload: {
        format: 'canonical-json',
        canonical: '{"message":"界"}',
        byteLength: 17,
        sha256: 'b'.repeat(64),
      },
    })

    expect(authorityViewerLines(value)).toEqual(
      expect.arrayContaining([
        { kind: 'metadata', text: 'Payload: canonical-json · 17 original UTF-8 bytes' },
        { kind: 'metadata', text: `SHA-256: ${'b'.repeat(64)}` },
        { kind: 'payload', text: '{"message":"界"}' },
      ]),
    )
  })
})
