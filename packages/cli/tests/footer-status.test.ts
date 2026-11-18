import { describe, expect, it } from 'vitest'

import { formatCwdForFooter, formatTokenSpeed, sameFormattedTokenSpeed } from '../src/ui/chat-input/text-helpers.js'
import { visualWidth } from '../src/ui/render/text-width.js'

describe('formatCwdForFooter', () => {
  it('contracts POSIX home directories and preserves up to two trailing segments', () => {
    const home = '/Users/bin'
    expect(formatCwdForFooter('/Users/bin', 24, home)).toBe('~')
    expect(formatCwdForFooter('/Users/bin/x-code-cli', 24, home)).toBe('~/x-code-cli')
    expect(formatCwdForFooter('/Users/bin/res/x-code-cli', 24, home)).toBe('~/res/x-code-cli')
    expect(formatCwdForFooter('/Users/bin/Desktop/res/x-code-cli', 24, home)).toBe('~/…/res/x-code-cli')
  })

  it('does not treat sibling prefixes of home as inside home', () => {
    expect(formatCwdForFooter('/Users/binary/project', 24, '/Users/bin')).toBe('/…/binary/project')
    expect(formatCwdForFooter('/Users/bin/project', 24, '.')).toBe('/…/bin/project')
  })

  it('strips terminal escapes, newlines, and tabs from untrusted directory names', () => {
    const dirty = '/Users/bin/work/bad\nline\x1b]0;spoof\x07\t\x1b[2Jrepo'
    const formatted = formatCwdForFooter(dirty, 30, '/Users/bin')
    expect(formatted).not.toContain('\n')
    expect(formatted).not.toContain('\t')
    expect(formatted).not.toContain('\x1b')
    expect(formatted).not.toContain('\x07')
    expect(formatted).toBe('~/work/bad line repo')
  })

  it('handles Windows drive and UNC paths cross-platform', () => {
    expect(formatCwdForFooter('C:\\Users\\bin\\Desktop\\res\\x-code-cli', 24, 'c:\\users\\bin')).toBe(
      '~/…/res/x-code-cli',
    )
    expect(formatCwdForFooter('D:\\work\\team\\repo', 24, 'C:\\Users\\bin')).toBe('D:/…/team/repo')
    expect(formatCwdForFooter('D:\\', 24, 'C:\\Users\\bin')).toBe('D:/')
    expect(formatCwdForFooter('\\\\fileserver\\eng\\platform\\service\\api', 30, 'C:\\Users\\bin')).toBe(
      '//fileserver/eng/…/service/api',
    )
    expect(formatCwdForFooter('\\\\fileserver\\eng\\platform\\service\\api', 28, 'C:\\Users\\bin')).toBe(
      '//fileserver/eng/…/api',
    )
  })

  it('degrades progressively as column budget shrinks and respects CJK widths', () => {
    const cwd = '/Users/bin/Desktop/res/x-code-cli'
    const home = '/Users/bin'

    expect(formatCwdForFooter(cwd, 18, home)).toBe('~/…/res/x-code-cli')
    expect(formatCwdForFooter(cwd, 16, home)).toBe('~/…/x-code-cli')
    expect(formatCwdForFooter(cwd, 12, home)).toBe('x-code-cli')
    expect(formatCwdForFooter(cwd, 9, home)).toBe('x-code-c…')
    expect(formatCwdForFooter(cwd, 5, home)).toBe('')

    expect(formatCwdForFooter('/Users/bin/工作区/核心模块/前端仓库', 21, home)).toBe('~/…/核心模块/前端仓库')
    const cjk = formatCwdForFooter('/Users/bin/工作区/核心模块/前端仓库', 20, home)
    expect(cjk).toBe('~/…/前端仓库')
    expect(visualWidth(cjk)).toBeLessThanOrEqual(20)
  })
})

describe('formatTokenSpeed', () => {
  it('formats live estimates and finalized rates compactly', () => {
    expect(formatTokenSpeed({ tokensPerSecond: 76.4, isEstimate: true })).toBe('~76 tok/s')
    expect(formatTokenSpeed({ tokensPerSecond: 0.3, isEstimate: true })).toBe('~1 tok/s')
    expect(formatTokenSpeed({ tokensPerSecond: 78.44, isEstimate: false })).toBe('78.4 tok/s')
    expect(formatTokenSpeed({ tokensPerSecond: 142.7, isEstimate: false })).toBe('143 tok/s')
    expect(formatTokenSpeed({ tokensPerSecond: 0, isEstimate: false })).toBe('')
    expect(formatTokenSpeed({ tokensPerSecond: Number.NaN, isEstimate: false })).toBe('')
  })

  it('deduplicates equivalent formatted speeds while distinguishing estimate from exact', () => {
    expect(
      sameFormattedTokenSpeed(
        { tokensPerSecond: 78.41, isEstimate: false },
        { tokensPerSecond: 78.44, isEstimate: false },
      ),
    ).toBe(true)
    expect(
      sameFormattedTokenSpeed(
        { tokensPerSecond: 78.0, isEstimate: true },
        { tokensPerSecond: 78.0, isEstimate: false },
      ),
    ).toBe(false)
  })
})
