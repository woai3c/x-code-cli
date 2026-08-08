import { describe, expect, it } from 'vitest'

import type { Marketplace } from '@x-code-cli/core'

import { searchMarketplacePlugins } from '../src/plugins/search.js'

describe('searchMarketplacePlugins', () => {
  it('matches names, descriptions, and keywords case-insensitively', () => {
    const marketplaces: Marketplace[] = [
      {
        schemaVersion: '1',
        name: 'official',
        plugins: [
          {
            name: 'reviewer',
            description: 'Reviews pull requests',
            keywords: ['Quality'],
            verified: true,
            source: { kind: 'github', owner: 'example', repo: 'reviewer' },
          },
          {
            name: 'formatter',
            source: { kind: 'github', owner: 'example', repo: 'formatter' },
          },
        ],
      },
    ]

    expect(searchMarketplacePlugins(marketplaces, 'QUALITY')).toEqual([
      {
        marketplace: 'official',
        name: 'reviewer',
        description: 'Reviews pull requests',
        verified: true,
      },
    ])
  })
})
