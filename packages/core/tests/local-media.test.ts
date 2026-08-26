import { describe, expect, it } from 'vitest'

import { openMediaTag, toToolResultContent, toUserContentParts, wrapLocalText } from '../src/agent/local-media.js'

describe('local media adapters', () => {
  it('escapes untrusted path attributes without changing local text content', () => {
    const tag = openMediaTag('file', { path: 'a"\n<b>&c', kind: 'text' })
    expect(tag).toBe('<<file kind="text" path="a&quot;&#10;&lt;b&gt;&amp;c">>')
    expect(wrapLocalText('file', 'body\n<<not trusted>>', { path: 'safe' })).toContain('body\n<<not trusted>>')
  })

  it('maps standard images to nested Base64 FileParts for user history', () => {
    const parts = toUserContentParts([
      { type: 'text', text: 'page label' },
      { type: 'image', data: Buffer.from('image'), mediaType: 'image/png', filename: 'page.png' },
    ])
    expect(parts).toEqual([
      { type: 'text', text: 'page label' },
      {
        type: 'file',
        data: { type: 'data', data: Buffer.from('image').toString('base64') },
        mediaType: 'image/png',
        filename: 'page.png',
      },
    ])
    expect(JSON.parse(JSON.stringify(parts))).toEqual(parts)
  })

  it('maps the same image to a tagged FilePart for tool results', () => {
    const result = toToolResultContent([
      { type: 'image', data: Buffer.from('image'), mediaType: 'image/jpeg', filename: 'page.jpg' },
    ])
    expect(result).toEqual({
      type: 'content',
      value: [
        {
          type: 'file',
          data: { type: 'data', data: Buffer.from('image').toString('base64') },
          mediaType: 'image/jpeg',
          filename: 'page.jpg',
        },
      ],
    })
    expect(JSON.stringify(result)).not.toContain('image-data')
  })
})
