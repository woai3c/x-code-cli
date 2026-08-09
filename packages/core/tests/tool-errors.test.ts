import { formatToolError } from '../src/utils/tool-errors.js'

describe('formatToolError', () => {
  it('includes nested causes that explain generic transport failures', () => {
    const cause = new Error('Hostname example.com resolved to disallowed IP address 198.18.1.86')
    const error = new TypeError('fetch failed', { cause })

    expect(formatToolError('fetching URL', error)).toBe(
      'Error fetching URL: fetch failed (cause: Hostname example.com resolved to disallowed IP address 198.18.1.86)',
    )
  })

  it('does not repeat duplicate cause messages', () => {
    const error = new Error('permission denied', { cause: new Error('permission denied') })
    expect(formatToolError('reading file', error)).toBe('Error reading file: permission denied')
  })
})
