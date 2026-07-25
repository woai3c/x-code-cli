import { describe, expect, it } from 'vitest'

import * as Core from '../src/index.js'

describe('@x-code-cli/core public API', () => {
  it('export list matches snapshot', () => {
    const exports = Object.keys(Core).sort()
    expect(exports).toMatchSnapshot()
  })
})
