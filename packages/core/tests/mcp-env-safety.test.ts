import { describe, expect, it } from 'vitest'

import { UnsafeEnvError, assertSafeEnv } from '../src/mcp/env-safety.js'

describe('assertSafeEnv', () => {
  it('accepts undefined and empty env', () => {
    expect(() => assertSafeEnv(undefined)).not.toThrow()
    expect(() => assertSafeEnv({})).not.toThrow()
  })

  it('accepts arbitrary application-level keys', () => {
    expect(() =>
      assertSafeEnv({
        OPENAI_API_KEY: 'sk-...',
        LOG_LEVEL: 'debug',
        MY_PLUGIN_TOKEN: 'xyz',
      }),
    ).not.toThrow()
  })

  it('rejects NODE_OPTIONS', () => {
    expect(() => assertSafeEnv({ NODE_OPTIONS: '--require ./evil.js' })).toThrow(UnsafeEnvError)
  })

  it('rejects LD_PRELOAD-class keys', () => {
    for (const k of ['LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT']) {
      expect(() => assertSafeEnv({ [k]: '/tmp/x.so' })).toThrow(UnsafeEnvError)
    }
  })

  it('rejects DYLD_* keys (macOS)', () => {
    for (const k of [
      'DYLD_INSERT_LIBRARIES',
      'DYLD_LIBRARY_PATH',
      'DYLD_FRAMEWORK_PATH',
      'DYLD_FALLBACK_LIBRARY_PATH',
      'DYLD_FALLBACK_FRAMEWORK_PATH',
    ]) {
      expect(() => assertSafeEnv({ [k]: '/tmp/x.dylib' })).toThrow(UnsafeEnvError)
    }
  })

  it('rejects shell init hooks', () => {
    for (const k of ['BASH_ENV', 'ENV', 'PROMPT_COMMAND']) {
      expect(() => assertSafeEnv({ [k]: '/tmp/x.sh' })).toThrow(UnsafeEnvError)
    }
  })

  it('rejects scripting-runtime injection hooks', () => {
    for (const k of ['PYTHONSTARTUP', 'PYTHONPATH', 'PERL5OPT', 'PERL5LIB', 'RUBYOPT', 'RUBYLIB']) {
      expect(() => assertSafeEnv({ [k]: '/tmp/x' })).toThrow(UnsafeEnvError)
    }
  })

  it('is case-insensitive — Windows env names ignore case at the OS level', () => {
    // The Windows env is canonically upper-cased by the OS, but Node will
    // happily pass through whatever case we hand to spawn. Rejecting only
    // the upper form would let a config slip through with `node_options:`.
    expect(() => assertSafeEnv({ Node_Options: '--require ./x.js' })).toThrow(UnsafeEnvError)
    expect(() => assertSafeEnv({ ld_preload: '/tmp/x.so' })).toThrow(UnsafeEnvError)
  })

  it('error names the offending key', () => {
    try {
      assertSafeEnv({ NODE_OPTIONS: 'x' })
      expect.fail('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(UnsafeEnvError)
      expect((err as UnsafeEnvError).key).toBe('NODE_OPTIONS')
    }
  })
})
