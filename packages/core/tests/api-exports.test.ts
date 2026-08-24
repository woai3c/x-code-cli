import { describe, expect, it } from 'vitest'

import type { ImagePart } from 'ai'

import * as Core from '../src/index.js'
import type { FileKind, IngestedPart } from '../src/index.js'

describe('@x-code-cli/core public API', () => {
  it('export list matches snapshot', () => {
    const exports = Object.keys(Core).sort()
    expect(exports).toMatchSnapshot()
  })

  it('retains the legacy file-ingestion type members', () => {
    const kind: FileKind = 'unknown'
    const image: ImagePart = { type: 'image', image: 'AA==', mediaType: 'image/png' }
    const part: IngestedPart = image

    expect(kind).toBe('unknown')
    expect(part.type).toBe('image')
  })
})
