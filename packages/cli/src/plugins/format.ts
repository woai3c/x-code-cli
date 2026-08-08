import type { PluginSource } from '@x-code-cli/core'

export function formatPluginSource(source: PluginSource | undefined): string {
  if (!source) return '(unknown)'
  if (source.kind === 'local') return `local: ${source.path}`
  if (source.kind === 'git') return `git: ${source.url}${source.ref ? `#${source.ref}` : ''}`
  return `github:${source.owner}/${source.repo}${source.ref ? `#${source.ref}` : ''}`
}
