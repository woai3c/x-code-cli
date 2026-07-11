import { describe, expect, it, vi } from 'vitest'

import path from 'node:path'

import { restoreInvocationCwd } from '../src/launch-cwd.js'

describe('restoreInvocationCwd', () => {
  it('restores an absolute package-manager invocation directory', () => {
    const chdir = vi.fn()
    const invocationCwd = path.resolve('workspace')

    expect(restoreInvocationCwd(invocationCwd, chdir)).toBe(true)
    expect(chdir).toHaveBeenCalledWith(invocationCwd)
  })

  it('ignores missing and relative INIT_CWD values', () => {
    const chdir = vi.fn()

    expect(restoreInvocationCwd('', chdir)).toBe(false)
    expect(restoreInvocationCwd('relative/path', chdir)).toBe(false)
    expect(chdir).not.toHaveBeenCalled()
  })

  it('keeps the current directory when chdir fails', () => {
    const chdir = vi.fn(() => {
      throw new Error('missing directory')
    })

    expect(restoreInvocationCwd(path.resolve('missing'), chdir)).toBe(false)
  })
})
