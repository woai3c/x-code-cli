// @x-code-cli/core — Sanitization for browser/MCP diagnostics before they
// reach model context or the terminal UI.
import { redactMemoryText } from '../../knowledge/memory/redaction.js'

const CONTROL_CHAR_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g
const ANSI_ESCAPE_RE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?)/g
const URL_SECRET_RE =
  /([#?&](?:access[_-]?token|api[_-]?key|auth|authorization|code|cookie|credential|jwt|key|password|passwd|secret|session(?:id)?|signature|token)=)[^&\s]+/gi
const AUTH_HEADER_RE = /(\b(?:Authorization|Cookie|Set-Cookie)\s*:\s*)[^\r\n]+/gi
const BEARER_TOKEN_RE = /(\bBearer\s+)[A-Za-z0-9._~+/=-]+/gi
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g
const SECRET_FIELD_NAME = String.raw`(?:(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|auth|authorization|cookie|credential|jwt|key|password|passwd|private[_-]?key|secret|session(?:[_-]?id)?|signature|token)|accessToken|apiKey|clientSecret|idToken|privateKey|refreshToken|secretAccessKey|sessionId)`
const JSON_SECRET_RE = new RegExp(`("${SECRET_FIELD_NAME}"\\s*:\\s*)"(?:\\\\.|[^"\\\\])*"`, 'gi')
const LABELED_SECRET_RE = new RegExp(
  `(\\b${SECRET_FIELD_NAME}\\b\\s*[:=]\\s*)(?:"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|[^\\s,;}]+)`,
  'gi',
)

export function sanitizeBrowserDiagnostic(value: unknown, maxChars = 3_000, emptyFallback = '(none reported)'): string {
  const sanitized = redactMemoryText(
    String(value ?? '')
      .replace(ANSI_ESCAPE_RE, '')
      .replace(CONTROL_CHAR_RE, '')
      .replace(URL_SECRET_RE, '$1[REDACTED]')
      .replace(AUTH_HEADER_RE, '$1[REDACTED]')
      .replace(BEARER_TOKEN_RE, '$1[REDACTED]')
      .replace(JWT_RE, '[REDACTED_JWT]')
      .replace(JSON_SECRET_RE, '$1"[REDACTED]"')
      .replace(LABELED_SECRET_RE, '$1[REDACTED]'),
  ).trim()
  if (!sanitized) return emptyFallback
  if (sanitized.length <= maxChars) return sanitized
  return `${sanitized.slice(0, maxChars)}\n[browser diagnostics truncated]`
}
