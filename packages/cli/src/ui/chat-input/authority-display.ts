import type { AuthorityApprovalPreview } from '@x-code-cli/core'

function visibleEscape(codePoint: number): string | undefined {
  if (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x061c ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff)
  ) {
    return `\\u${codePoint.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return undefined
}

/**
 * Convert untrusted authority-viewer text into terminal-inert, auditable
 * lines. Line endings become application-owned row boundaries; every other
 * terminal or bidi control remains visible as a fixed-width Unicode escape.
 */
export function authorityVisibleLines(value: string): string[] {
  const lines = ['']
  for (let index = 0; index < value.length; ) {
    const codePoint = value.codePointAt(index)!
    if (codePoint === 0x0d || codePoint === 0x0a) {
      if (codePoint === 0x0d && value.charCodeAt(index + 1) === 0x0a) index++
      lines.push('')
      index++
      continue
    }
    lines[lines.length - 1] += visibleEscape(codePoint) ?? String.fromCodePoint(codePoint)
    index += codePoint > 0xffff ? 2 : 1
  }
  return lines
}

export function authorityVisibleText(value: string): string {
  return authorityVisibleLines(value).join('\\n')
}

function labeledLines(label: string, value: string): string[] {
  const lines = authorityVisibleLines(value)
  const continuation = ' '.repeat(label.length + 2)
  return lines.map((line, index) => (index === 0 ? `${label}: ${line}` : `${continuation}${line}`))
}

export function authorityMetadataLines(preview: AuthorityApprovalPreview): string[] {
  return [
    ...labeledLines('Tool', preview.toolName),
    ...(preview.serverId ? labeledLines('Server', preview.serverId) : []),
    ...(preview.destination ? labeledLines('Destination', preview.destination) : []),
    ...(preview.paths?.length ? labeledLines('Paths', preview.paths.join(', ')) : []),
  ]
}

export function authorityPayloadLines(preview: AuthorityApprovalPreview): string[] {
  return authorityVisibleLines(preview.outboundPayload?.canonical ?? JSON.stringify(preview))
}

export interface AuthorityViewerLine {
  kind: 'metadata' | 'payload'
  text: string
}

export function authorityViewerLines(preview: AuthorityApprovalPreview): AuthorityViewerLine[] {
  const identity = preview.outboundPayload
    ? [
        `Payload: ${preview.outboundPayload.format} · ${preview.outboundPayload.byteLength} original UTF-8 bytes`,
        `SHA-256: ${preview.outboundPayload.sha256}`,
      ]
    : [`Canonical call SHA-256: ${preview.canonicalCallSha256}`]
  return [
    ...authorityMetadataLines(preview).map((text) => ({ kind: 'metadata' as const, text })),
    ...identity.map((text) => ({ kind: 'metadata' as const, text })),
    ...authorityPayloadLines(preview).map((text) => ({ kind: 'payload' as const, text })),
  ]
}
