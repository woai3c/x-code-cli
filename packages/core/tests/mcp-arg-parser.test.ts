import { describe, expect, it } from 'vitest'

import { parseAdd, parseAddJson, parseRemove, tokenize } from '../src/mcp/arg-parser.js'

describe('tokenize', () => {
  it('splits on whitespace', () => {
    expect(tokenize('a b c')).toEqual({ ok: true, tokens: ['a', 'b', 'c'] })
  })

  it('preserves double-quoted spans', () => {
    expect(tokenize('a "b c" d')).toEqual({ ok: true, tokens: ['a', 'b c', 'd'] })
  })

  it('preserves single-quoted spans', () => {
    expect(tokenize("a 'b c' d")).toEqual({ ok: true, tokens: ['a', 'b c', 'd'] })
  })

  it('escapes whitespace with backslash outside quotes', () => {
    expect(tokenize('a\\ b c')).toEqual({ ok: true, tokens: ['a b', 'c'] })
  })

  it('escapes quote/backslash outside quotes', () => {
    expect(tokenize('a\\"b \\\\c')).toEqual({ ok: true, tokens: ['a"b', '\\c'] })
  })

  it('preserves backslash-non-special as a literal pair (Windows paths)', () => {
    // Regression: a previous POSIX-style "backslash escapes any char" rule
    // ate path separators on Windows. `D:\res\x-code-cli\tmp` MUST survive.
    expect(tokenize('D:\\res\\x-code-cli\\tmp')).toEqual({
      ok: true,
      tokens: ['D:\\res\\x-code-cli\\tmp'],
    })
  })

  it('handles backslash-escape inside double quotes', () => {
    expect(tokenize('"a\\"b"')).toEqual({ ok: true, tokens: ['a"b'] })
  })

  it('rejects unclosed quote', () => {
    expect(tokenize('a "b')).toEqual({ ok: false, error: 'Unclosed " quote' })
  })

  it('returns empty for empty/whitespace-only input', () => {
    expect(tokenize('')).toEqual({ ok: true, tokens: [] })
    expect(tokenize('   ')).toEqual({ ok: true, tokens: [] })
  })
})

describe('parseAdd — stdio', () => {
  it('parses bare stdio: name + command + args', () => {
    const r = parseAdd('fs npx -y @modelcontextprotocol/server-filesystem /tmp')
    expect(r).toEqual({
      ok: true,
      command: {
        kind: 'add',
        name: 'fs',
        scope: 'user',
        config: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
        },
      },
    })
  })

  it('accepts -- separator before the command', () => {
    const r = parseAdd('fs -- npx -y pkg')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.command.name).toBe('fs')
      expect((r.command.config as { command: string; args?: string[] }).command).toBe('npx')
      expect((r.command.config as { command: string; args?: string[] }).args).toEqual(['-y', 'pkg'])
    }
  })

  it('collects multiple --env flags into env object', () => {
    const r = parseAdd('--env A=1 --env B=hello srv node ./s.js')
    expect(r.ok).toBe(true)
    if (r.ok) {
      const cfg = r.command.config as { env?: Record<string, string> }
      expect(cfg.env).toEqual({ A: '1', B: 'hello' })
    }
  })

  it('allows --env values containing =', () => {
    const r = parseAdd('--env URL=https://x.com?a=1 srv node s.js')
    expect(r.ok).toBe(true)
    if (r.ok) {
      const cfg = r.command.config as { env?: Record<string, string> }
      expect(cfg.env).toEqual({ URL: 'https://x.com?a=1' })
    }
  })

  it('accepts --timeout', () => {
    const r = parseAdd('--timeout 60000 srv node s.js')
    expect(r.ok).toBe(true)
    if (r.ok) {
      const cfg = r.command.config as { timeout?: number }
      expect(cfg.timeout).toBe(60000)
    }
  })

  it('accepts --scope project', () => {
    const r = parseAdd('--scope project srv node s.js')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.command.scope).toBe('project')
  })

  it('rejects --header with stdio', () => {
    const r = parseAdd('--header "X: Y" srv node s.js')
    expect(r).toEqual({ ok: false, error: expect.stringContaining('--header is only valid for HTTP') })
  })

  it('rejects invalid name (single bad token)', () => {
    // `server!` — single token containing punctuation that fails NAME_RE.
    // Multi-word "my server" would tokenise into separate args and "my"
    // alone is a valid name, so we use a single-token failure case here.
    const r = parseAdd('server! npx pkg')
    expect(r.ok).toBe(false)
  })

  it('rejects bad --env shape', () => {
    expect(parseAdd('--env NOVAL srv cmd').ok).toBe(false)
    expect(parseAdd('--env =val srv cmd').ok).toBe(false)
  })

  it('preserves Windows-style backslash paths in args', () => {
    // Regression for the bug where `D:\res\x-code-cli\tmp` got mangled
    // into `D:resx-code-clitmp` because the tokenizer ate the backslashes.
    const r = parseAdd('fs npx -y @modelcontextprotocol/server-filesystem D:\\res\\x-code-cli\\tmp')
    expect(r.ok).toBe(true)
    if (r.ok) {
      const cfg = r.command.config as { args: string[] }
      expect(cfg.args).toEqual(['-y', '@modelcontextprotocol/server-filesystem', 'D:\\res\\x-code-cli\\tmp'])
    }
  })

  it('omits empty args/env from the config', () => {
    const r = parseAdd('srv cmd-only')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.command.config).toEqual({ command: 'cmd-only' })
    }
  })

  it('requires at least name + command', () => {
    expect(parseAdd('').ok).toBe(false)
    expect(parseAdd('srv').ok).toBe(false)
  })
})

describe('parseAdd — http', () => {
  it('parses --http with url', () => {
    const r = parseAdd('--http sentry https://mcp.sentry.dev/mcp')
    expect(r).toEqual({
      ok: true,
      command: {
        kind: 'add',
        name: 'sentry',
        scope: 'user',
        config: { url: 'https://mcp.sentry.dev/mcp' },
      },
    })
  })

  it('accepts --transport http as alias', () => {
    const r = parseAdd('--transport http sentry https://mcp.sentry.dev/mcp')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect((r.command.config as { url: string }).url).toBe('https://mcp.sentry.dev/mcp')
    }
  })

  it('rejects --transport sse explicitly', () => {
    const r = parseAdd('--transport sse sentry https://mcp.sentry.dev/mcp')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/only supports "http"/)
  })

  it('collects multiple --header flags', () => {
    const r = parseAdd('--http --header "X-A: 1" --header "X-B: 2" srv https://x.com')
    expect(r.ok).toBe(true)
    if (r.ok) {
      const cfg = r.command.config as { headers?: Record<string, string> }
      expect(cfg.headers).toEqual({ 'X-A': '1', 'X-B': '2' })
    }
  })

  it('rejects --env with --http', () => {
    const r = parseAdd('--http --env A=B srv https://x.com')
    expect(r).toEqual({ ok: false, error: expect.stringContaining('--env is only valid for stdio') })
  })

  it('rejects invalid url', () => {
    const r = parseAdd('--http srv ftp://x.com')
    expect(r.ok).toBe(false)
  })

  it('rejects extra positional args for http', () => {
    const r = parseAdd('--http srv https://x.com extra-token')
    expect(r.ok).toBe(false)
  })
})

describe('parseAddJson', () => {
  it('parses a JSON blob into a config', () => {
    const r = parseAddJson('myserver \'{"command":"node","args":["s.js"]}\'')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.command.name).toBe('myserver')
      expect(r.command.config).toEqual({ command: 'node', args: ['s.js'] })
    }
  })

  it('accepts --scope project', () => {
    const r = parseAddJson('--scope project srv \'{"command":"x"}\'')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.command.scope).toBe('project')
  })

  it('rejects invalid JSON', () => {
    const r = parseAddJson("srv 'not-json'")
    expect(r.ok).toBe(false)
  })

  it('rejects non-object JSON', () => {
    const r = parseAddJson('srv \'["a","b"]\'')
    expect(r.ok).toBe(false)
  })

  it('rejects missing JSON', () => {
    expect(parseAddJson('srv').ok).toBe(false)
    expect(parseAddJson('').ok).toBe(false)
  })

  it('rejects invalid name', () => {
    const r = parseAddJson('bad name! \'{"command":"x"}\'')
    expect(r.ok).toBe(false)
  })
})

describe('parseRemove', () => {
  it('parses bare name', () => {
    expect(parseRemove('sentry')).toEqual({
      ok: true,
      command: { kind: 'remove', name: 'sentry', scope: undefined },
    })
  })

  it('parses --scope user', () => {
    const r = parseRemove('--scope user sentry')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.command.scope).toBe('user')
  })

  it('parses --scope project', () => {
    const r = parseRemove('--scope project sentry')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.command.scope).toBe('project')
  })

  it('rejects extra args', () => {
    expect(parseRemove('a b').ok).toBe(false)
  })

  it('rejects missing name', () => {
    expect(parseRemove('').ok).toBe(false)
    expect(parseRemove('--scope user').ok).toBe(false)
  })

  it('rejects unknown flag', () => {
    expect(parseRemove('--force sentry').ok).toBe(false)
  })
})
