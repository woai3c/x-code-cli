import { parseScopeFlag } from '../src/ui/app/commands/scope-flag.js'

describe('parseScopeFlag', () => {
  it('extracts long and short scope flags while preserving the remaining argument', () => {
    expect(parseScopeFlag('alpha --scope=project')).toEqual({ value: 'alpha', scope: 'project' })
    expect(parseScopeFlag('-s=user alpha beta')).toEqual({ value: 'alpha beta', scope: 'user' })
  })

  it('keeps the supplied default when a scope flag has an unknown value', () => {
    expect(parseScopeFlag('alpha --scope=invalid', 'user')).toEqual({ value: 'alpha', scope: 'user' })
  })

  it('leaves scope undefined when no default or valid flag is present', () => {
    expect(parseScopeFlag('alpha')).toEqual({ value: 'alpha', scope: undefined })
  })
})
