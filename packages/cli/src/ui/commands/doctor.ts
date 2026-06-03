// @x-code-cli/cli — /doctor slash command handler.
//
// One-shot environment diagnostic: checks API keys, Node version, shell
// availability, MCP server health, plugin load errors, custom agent parse
// state, and knowledge file sizes. Modelled after Claude Code's /doctor
// but scoped to what x-code-cli actually needs.
import { getAvailableProviders, getEnvVarName } from '@x-code-cli/core'
import type { AgentOptions } from '@x-code-cli/core'

import { VERSION } from '../../version.js'

export interface DoctorCommandDeps {
  options: AgentOptions
  modelId: string
  addInfoMessage: (content: string) => void
  echoCommand: (text: string) => void
}

/** All known provider keys — order matches PROVIDER_DETECTION_ORDER. */
const ALL_PROVIDERS = ['anthropic', 'openai', 'deepseek', 'google', 'alibaba', 'xai', 'zhipu', 'moonshotai'] as const

export function createDoctorCommandHandler(deps: DoctorCommandDeps) {
  const { options, modelId, addInfoMessage, echoCommand } = deps

  function handleDoctor(text: string): void {
    echoCommand(text)
    const sections: string[] = []

    // ── Environment ────────────────────────────────────────────────────
    {
      const lines = ['**Environment**', '']
      lines.push(`- Version: ${VERSION}`)
      lines.push(`- Node:    ${process.version}`)
      lines.push(`- Model:   ${modelId}`)
      lines.push(`- OS:      ${process.platform} ${process.arch}`)

      const nodeVersion = parseInt(process.version.slice(1), 10)
      if (nodeVersion < 20) {
        lines.push('', '⚠ Node ≥ 20.19 is required. Current version may cause issues.')
      }
      sections.push(lines.join('\n'))
    }

    // ── API Keys ───────────────────────────────────────────────────────
    {
      const available = new Set(getAvailableProviders())
      const lines = ['**API Keys**', '']
      for (const p of ALL_PROVIDERS) {
        const envVar = getEnvVarName(p)
        const ok = available.has(p)
        lines.push(`- ${p}: ${ok ? '✓' : `✗  (set \`${envVar}\`)`}`)
      }
      // Custom provider
      const hasCustom = available.has('custom')
      if (hasCustom) {
        lines.push('- custom: ✓')
      }
      const configuredCount = available.size
      if (configuredCount === 0) {
        lines.push('', '⚠ No provider configured. Set at least one API key to use the CLI.')
      }
      sections.push(lines.join('\n'))
    }

    // ── MCP Servers ────────────────────────────────────────────────────
    {
      const statuses = options.mcpRegistry?.serverStatus() ?? []
      const lines = ['**MCP Servers**', '']
      if (statuses.length === 0) {
        lines.push('_(none configured)_')
      } else {
        for (const s of statuses) {
          const kind = s.status.kind
          if (kind === 'connected') {
            const st = s.status as { kind: 'connected'; toolCount: number; resourceCount: number }
            lines.push(`- ${s.name}: ✓ connected (${st.toolCount} tools, ${st.resourceCount} resources)`)
          } else if (kind === 'failed') {
            const st = s.status as { kind: 'failed'; error: string }
            const errSnippet = st.error.length > 80 ? st.error.slice(0, 80) + '…' : st.error
            lines.push(`- ${s.name}: ✗ failed — ${errSnippet}`)
            if (s.stderrTail) {
              lines.push(`  stderr: ${s.stderrTail.slice(0, 120)}`)
            }
          } else if (kind === 'needs_auth') {
            lines.push(`- ${s.name}: ⚠ needs authentication — run \`/mcp auth ${s.name}\``)
          } else if (kind === 'disabled') {
            lines.push(`- ${s.name}: — disabled`)
          } else {
            lines.push(`- ${s.name}: ${kind}`)
          }
        }
        const failedCount = statuses.filter((s) => s.status.kind === 'failed').length
        if (failedCount > 0) {
          lines.push(
            '',
            `⚠ ${failedCount} server${failedCount === 1 ? '' : 's'} failed. Check config or run \`/mcp refresh\`.`,
          )
        }
      }
      sections.push(lines.join('\n'))
    }

    // ── Plugins ────────────────────────────────────────────────────────
    {
      const all = options.pluginRegistry?.listAll() ?? []
      const errors = options.pluginRegistry?.loadErrors() ?? []
      const lines = ['**Plugins**', '']
      const enabled = all.filter((p) => p.enabled).length
      const disabled = all.length - enabled
      lines.push(`- Loaded: ${all.length} (${enabled} enabled, ${disabled} disabled)`)
      lines.push(`- Errors: ${errors.length}`)
      if (errors.length > 0) {
        lines.push('')
        for (const e of errors) {
          lines.push(`  ✗ ${e.id ?? '(unknown)'} — ${e.message}`)
        }
        lines.push('', 'Run `/plugin doctor` for details.')
      }
      sections.push(lines.join('\n'))
    }

    // ── Sub-Agents ─────────────────────────────────────────────────────
    {
      const agents = options.subAgentRegistry?.list() ?? []
      const lines = ['**Sub-Agents**', '']
      const builtIn = agents.filter((a) => a.source === 'built-in').length
      const custom = agents.length - builtIn
      lines.push(`- Total: ${agents.length} (${builtIn} built-in, ${custom} custom)`)
      if (custom > 0) {
        const customAgents = agents.filter((a) => a.source !== 'built-in')
        for (const a of customAgents) {
          lines.push(`  • ${a.name} (${a.source}${a.pluginId ? `, plugin: ${a.pluginId}` : ''})`)
        }
      }
      sections.push(lines.join('\n'))
    }

    // ── Skills ─────────────────────────────────────────────────────────
    {
      const skills = options.skillRegistry?.listAll() ?? []
      const lines = ['**Skills**', '']
      const enabled = skills.filter((s) => !s.disabled).length
      const disabled = skills.length - enabled
      lines.push(`- Total: ${skills.length} (${enabled} enabled, ${disabled} disabled)`)
      sections.push(lines.join('\n'))
    }

    // ── Commands ────────────────────────────────────────────────────────
    {
      const commands = options.commandRegistry?.list() ?? []
      const lines = ['**Commands**', '']
      if (commands.length === 0) {
        lines.push('_(none from plugins)_')
      } else {
        lines.push(`- Total: ${commands.length}`)
        for (const cmd of commands) {
          lines.push(`  • /${cmd.name} (${cmd.source}${cmd.pluginId ? `, plugin: ${cmd.pluginId}` : ''})`)
        }
      }
      sections.push(lines.join('\n'))
    }

    // ── Assemble ───────────────────────────────────────────────────────
    addInfoMessage(sections.join('\n\n'))
  }

  return handleDoctor
}
