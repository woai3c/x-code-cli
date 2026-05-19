import { describe, expect, it } from 'vitest'

import { EnvExpansionError, expandEnvDeep, expandEnvString } from '../src/mcp/expand-env.js'

describe('expandEnvString', () => {
  it('substitutes simple references', () => {
    expect(expandEnvString('hello ${NAME}', { NAME: 'world' } as NodeJS.ProcessEnv)).toBe('hello world')
  })

  it('substitutes multiple references in one string', () => {
    expect(expandEnvString('${A}/${B}/${C}', { A: '1', B: '2', C: '3' } as NodeJS.ProcessEnv)).toBe('1/2/3')
  })

  it('throws EnvExpansionError on missing variable without default', () => {
    expect(() => expandEnvString('${MISSING_VAR}', {} as NodeJS.ProcessEnv)).toThrow(EnvExpansionError)
  })

  it('uses :- fallback when variable missing or empty', () => {
    expect(expandEnvString('${X:-fallback}', {} as NodeJS.ProcessEnv)).toBe('fallback')
    expect(expandEnvString('${X:-fallback}', { X: '' } as NodeJS.ProcessEnv)).toBe('fallback')
    expect(expandEnvString('${X:-fallback}', { X: 'real' } as NodeJS.ProcessEnv)).toBe('real')
  })

  it('leaves non-matching $ patterns alone', () => {
    // Single-$ patterns and unterminated ${ should pass through untouched —
    // we don't support shell-style $VAR.
    expect(expandEnvString('cost: $5', {} as NodeJS.ProcessEnv)).toBe('cost: $5')
    expect(expandEnvString('${unfinished', {} as NodeJS.ProcessEnv)).toBe('${unfinished')
  })
})

describe('expandEnvDeep', () => {
  it('walks arrays and objects', () => {
    const input = {
      command: '${BIN}',
      args: ['--token', '${TOKEN}'],
      env: { LOG: '${LEVEL:-info}' },
      timeout: 30000,
    }
    const env = { BIN: 'node', TOKEN: 'abc' } as NodeJS.ProcessEnv
    const out = expandEnvDeep(input, env)
    expect(out).toEqual({
      command: 'node',
      args: ['--token', 'abc'],
      env: { LOG: 'info' },
      timeout: 30000,
    })
  })

  it('does not mutate the input', () => {
    const input = { command: '${BIN}' }
    const env = { BIN: 'foo' } as NodeJS.ProcessEnv
    expandEnvDeep(input, env)
    expect(input.command).toBe('${BIN}')
  })

  it('preserves null / boolean / number primitives', () => {
    expect(expandEnvDeep({ a: null, b: true, c: 5 } as Record<string, unknown>, {} as NodeJS.ProcessEnv)).toEqual({
      a: null,
      b: true,
      c: 5,
    })
  })
})
