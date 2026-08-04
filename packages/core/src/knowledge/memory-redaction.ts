const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\b(?:sk|rk|pk)-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_API_KEY]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\b/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\bgithub_pat_[A-Za-z0-9_]{16,}\b/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\bglpat-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_TOKEN]'],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, '[REDACTED_GOOGLE_KEY]'],
  [/\bxai-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_API_KEY]'],
  [/\bhf_[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_TOKEN]'],
  [/\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, '[REDACTED_API_KEY]'],
  [/\bnpm_[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_TOKEN]'],
  [/\bxox[a-z]-[A-Za-z0-9-]{16,}\b/g, '[REDACTED_TOKEN]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]'],
  [/\b(?:Bearer\s+)[A-Za-z0-9._~+/=-]{16,}\b/gi, 'Bearer [REDACTED_TOKEN]'],
  [/(\b(?:api[_-]?key|access[_-]?token|secret|password|passwd)\b\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]'],
  [/\b[A-Za-z0-9+/]{160,}={0,2}\b/g, '[REDACTED_BASE64]'],
]

export function redactMemoryText(value: string): string {
  let redacted = value
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, replacement)
  }
  return redacted
}

export function redactMemoryValue<T>(value: T): T {
  if (typeof value === 'string') return redactMemoryText(value) as T
  if (Array.isArray(value)) return value.map((item) => redactMemoryValue(item)) as T
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) result[key] = redactMemoryValue(item)
    return result as T
  }
  return value
}
