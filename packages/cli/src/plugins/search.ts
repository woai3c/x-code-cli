import type { Marketplace } from '@x-code-cli/core'

export interface MarketplacePluginMatch {
  marketplace: string
  name: string
  description?: string
  verified?: boolean
}

export function searchMarketplacePlugins(
  marketplaces: readonly Marketplace[],
  keyword: string,
): MarketplacePluginMatch[] {
  const normalizedKeyword = keyword.toLowerCase()
  const matches: MarketplacePluginMatch[] = []

  for (const marketplace of marketplaces) {
    for (const plugin of marketplace.plugins) {
      const searchableText = [plugin.name, plugin.description ?? '', ...(plugin.keywords ?? [])].join(' ').toLowerCase()
      if (searchableText.includes(normalizedKeyword)) {
        matches.push({
          marketplace: marketplace.name,
          name: plugin.name,
          description: plugin.description,
          verified: plugin.verified,
        })
      }
    }
  }

  return matches
}
