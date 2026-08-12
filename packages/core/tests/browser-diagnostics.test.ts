import { describe, expect, it } from 'vitest'

import { sanitizeBrowserDiagnostic } from '../src/agent/browser/diagnostics.js'

describe('browser diagnostic sanitization', () => {
  it('redacts environment-style, labeled, and JSON secrets', () => {
    const diagnostic = [
      'OPENAI_API_KEY=sk-short-but-sensitive',
      'CUSTOM_TOKEN="custom-secret"',
      "password: 'hunter2'",
      '{"password":"json-password","accessToken":"json-access","safe":"visible"}',
    ].join('\n')

    const result = sanitizeBrowserDiagnostic(diagnostic)

    for (const secret of ['sk-short-but-sensitive', 'custom-secret', 'hunter2', 'json-password', 'json-access']) {
      expect(result).not.toContain(secret)
    }
    expect(result).toContain('"safe":"visible"')
    expect(result.match(/\[REDACTED]/g)?.length).toBeGreaterThanOrEqual(5)
  })

  it('retains ordinary diagnostic fields that merely contain similar letters', () => {
    const result = sanitizeBrowserDiagnostic('monkey=visible tokenCount=3 keyboard=ready')

    expect(result).toBe('monkey=visible tokenCount=3 keyboard=ready')
  })
})
