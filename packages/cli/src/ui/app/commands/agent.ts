// @x-code-cli/cli — /agent slash command: inspect sub-agents and configure sub-agent models.
import {
  createModelRegistry,
  getAvailableProviders,
  getOpenAIAuthStatus,
  getOpenAIChatGPTModelCatalogState,
  getProviderModels,
  loadUserConfig,
  normalizeSubAgentModelSpec,
  resolveSubAgentModelSelection,
  saveUserConfig,
} from '@x-code-cli/core'
import type { AgentOptions, SubAgentDefinition } from '@x-code-cli/core'

import { GLYPH_BULLET } from '../../render/terminal-glyphs.js'
import { promptProviderBaseUrl, renderModelLabel } from '../model-activation.js'

const USAGE_TEXT =
  'Usage: `/agent` · `/agent list` · `/agent <name> [model|inherit]` · `/agent model [name] <model|inherit>` · `/agent reset`'

export interface AgentCommandDeps {
  options: AgentOptions
  modelId: string
  addCommandMessage: (text: string, content: string) => void
  askQuestion: (
    question: string,
    options: { label: string; description: string }[],
    opts?: { noOther?: boolean },
  ) => Promise<string>
}

function isResetKeyword(raw: string): boolean {
  const lower = raw.trim().toLowerCase()
  return lower === 'inherit' || lower === 'reset' || lower === 'default'
}

function formatAgentSource(agent: SubAgentDefinition): string {
  if (agent.pluginId) return `plugin: ${agent.pluginId}`
  return agent.source
}

function isSafeAgentKey(name: string): boolean {
  return Boolean(name) && name !== '__proto__' && name !== 'constructor' && name !== 'prototype'
}

function findAgentByName(agents: readonly SubAgentDefinition[], rawName: string): SubAgentDefinition | undefined {
  return agents.find((a) => a.name === rawName) ?? agents.find((a) => a.name.toLowerCase() === rawName.toLowerCase())
}

export function createAgentCommandHandler(deps: AgentCommandDeps) {
  const { options, modelId, addCommandMessage, askQuestion } = deps

  const activeMainModelId = (): string => options.modelId || modelId

  function formatEffectiveModel(agent: SubAgentDefinition): string {
    const mainId = activeMainModelId()
    const selection = resolveSubAgentModelSelection(agent, mainId)
    if (selection.source === 'inherit') {
      return `inherit (${mainId})`
    }
    const resolved = selection.modelId ?? mainId
    const label = renderModelLabel(resolved)
    const display = label === resolved ? `\`${resolved}\`` : `**${label}** (\`${resolved}\`)`
    return `${display} _(${selection.source})_`
  }

  function validateAndMaterializeModel(text: string, rawInput: string): string | null {
    const resolved = normalizeSubAgentModelSpec(rawInput)
    if (!resolved || !resolved.includes(':')) {
      addCommandMessage(text, `Could not resolve model: \`${rawInput}\``)
      return null
    }
    if (getOpenAIAuthStatus().mode === 'chatgpt' && resolved.startsWith('openai:')) {
      const catalog = getOpenAIChatGPTModelCatalogState()
      if (catalog?.errorCode === 'login-required' || catalog?.errorCode === 'credentials-invalid') {
        addCommandMessage(text, 'ChatGPT authentication needs attention. Run `/login` again.')
        return null
      }
      if (!(getProviderModels().openai ?? []).some((m) => m.id === resolved)) {
        addCommandMessage(text, `\`${resolved}\` is not available for the signed-in ChatGPT account.`)
        return null
      }
    }
    try {
      const registry = createModelRegistry()
      registry.languageModel(resolved as `${string}:${string}`)
      options.modelRegistry = registry
      return resolved
    } catch (err) {
      addCommandMessage(
        text,
        `Failed to set sub-agent model \`${resolved}\`: ${err instanceof Error ? err.message : String(err)}`,
      )
      return null
    }
  }

  function applyGlobalModel(text: string, rawModel: string): void {
    const mainId = activeMainModelId()
    const config = loadUserConfig()
    if (isResetKeyword(rawModel)) {
      if (!config.subAgentModel) {
        addCommandMessage(text, `Default sub-agent model already inherits **${renderModelLabel(mainId)}**.`)
        return
      }
      const saved = saveUserConfig({ subAgentModel: undefined })
      if (!saved) {
        addCommandMessage(text, 'Failed to write `~/.x-code/config.json`.')
        return
      }
      addCommandMessage(text, `Default sub-agent model reset to inherit main model (**${renderModelLabel(mainId)}**).`)
      return
    }

    const resolved = validateAndMaterializeModel(text, rawModel)
    if (!resolved) return
    if (config.subAgentModel === resolved) {
      addCommandMessage(text, `Default sub-agent model is already **${renderModelLabel(resolved)}** (\`${resolved}\`).`)
      return
    }
    const saved = saveUserConfig({ subAgentModel: resolved })
    if (!saved) {
      addCommandMessage(text, 'Failed to write `~/.x-code/config.json`.')
      return
    }
    addCommandMessage(
      text,
      `Default sub-agent model set to **${renderModelLabel(resolved)}** (\`${resolved}\`) — saved.`,
    )
  }

  function applyAgentModel(text: string, agent: SubAgentDefinition, rawModel: string): void {
    if (!isSafeAgentKey(agent.name)) {
      addCommandMessage(text, `Refusing reserved sub-agent key \`${agent.name}\`.`)
      return
    }
    const mainId = activeMainModelId()
    const config = loadUserConfig()
    const currentOverrides: Record<string, string> = { ...(config.subAgentModels ?? {}) }
    const existingOverride = Object.hasOwn(currentOverrides, agent.name) ? currentOverrides[agent.name] : undefined

    if (isResetKeyword(rawModel)) {
      if (!existingOverride) {
        const fallback = resolveSubAgentModelSelection(agent, mainId, config)
        addCommandMessage(
          text,
          `**${agent.name}** already inherits ${fallback.source === 'inherit' ? `main model (**${renderModelLabel(mainId)}**)` : `\`${fallback.modelId}\` (${fallback.source})`}.`,
        )
        return
      }
      delete currentOverrides[agent.name]
      const nextMap = Object.keys(currentOverrides).length > 0 ? currentOverrides : undefined
      const saved = saveUserConfig({ subAgentModels: nextMap })
      if (!saved) {
        addCommandMessage(text, 'Failed to write `~/.x-code/config.json`.')
        return
      }
      const fallback = resolveSubAgentModelSelection(agent, mainId)
      const targetDesc =
        fallback.source === 'inherit'
          ? `main model (**${renderModelLabel(mainId)}**)`
          : `**${renderModelLabel(fallback.modelId ?? mainId)}** (\`${fallback.modelId}\`, ${fallback.source})`
      addCommandMessage(text, `Reset **${agent.name}** model override — now follows ${targetDesc}.`)
      return
    }

    const resolved = validateAndMaterializeModel(text, rawModel)
    if (!resolved) return
    if (existingOverride === resolved) {
      addCommandMessage(text, `**${agent.name}** model is already **${renderModelLabel(resolved)}** (\`${resolved}\`).`)
      return
    }
    Object.defineProperty(currentOverrides, agent.name, {
      value: resolved,
      enumerable: true,
      writable: true,
      configurable: true,
    })
    const saved = saveUserConfig({ subAgentModels: currentOverrides })
    if (!saved) {
      addCommandMessage(text, 'Failed to write `~/.x-code/config.json`.')
      return
    }
    addCommandMessage(
      text,
      `Set **${agent.name}** model to **${renderModelLabel(resolved)}** (\`${resolved}\`) — saved.`,
    )
  }

  async function pickModelInteractive(text: string, target: SubAgentDefinition | 'all'): Promise<void> {
    const mainId = activeMainModelId()
    const config = loadUserConfig()
    const explicitCurrent =
      target === 'all'
        ? config.subAgentModel
        : config.subAgentModels && Object.hasOwn(config.subAgentModels, target.name)
          ? config.subAgentModels[target.name]
          : undefined

    let inheritLabel: string
    let inheritDescription: string
    if (target === 'all') {
      const marker = !explicitCurrent ? `${GLYPH_BULLET} ` : '  '
      inheritLabel = `${marker}Inherit main model (${mainId})`
      inheritDescription = 'Follow the active main conversation model when a sub-agent has no override'
    } else {
      const withoutOverride = { ...config, subAgentModels: undefined }
      const fallback = resolveSubAgentModelSelection(target, mainId, withoutOverride)
      const marker = !explicitCurrent ? `${GLYPH_BULLET} ` : '  '
      const fallbackId = fallback.modelId ?? mainId
      inheritLabel = `${marker}Inherit (${fallbackId})`
      inheritDescription =
        fallback.source === 'frontmatter'
          ? 'Follow model declared in this custom agent file'
          : fallback.source === 'default'
            ? 'Follow the default sub-agent model'
            : 'Follow the active main conversation model'
    }

    const availableProviders = new Set(getAvailableProviders())
    const chatGPTCatalog = getOpenAIChatGPTModelCatalogState()
    const openAIUnavailable =
      chatGPTCatalog?.errorCode === 'login-required' || chatGPTCatalog?.errorCode === 'credentials-invalid'
    const choices: { id: string; label: string; description: string }[] = [
      { id: 'inherit', label: inheritLabel, description: inheritDescription },
    ]
    for (const [provider, models] of Object.entries(getProviderModels())) {
      if (!availableProviders.has(provider)) continue
      if (provider === 'openai' && openAIUnavailable) continue
      for (const m of models) {
        const marker = explicitCurrent === m.id ? `${GLYPH_BULLET} ` : '  '
        choices.push({ id: m.id, label: `${marker}${m.label}`, description: `${m.id} — ${m.description}` })
      }
    }

    const header =
      target === 'all'
        ? `Default sub-agent model (main: ${mainId})\nPick a model (${GLYPH_BULLET} = current):`
        : `Sub-agent: ${target.name} (main: ${mainId})\nPick a model (${GLYPH_BULLET} = current):`
    const answer = await askQuestion(
      header,
      choices.map((c) => ({ label: c.label, description: c.description })),
    )
    if (!answer) {
      addCommandMessage(text, 'Cancelled — sub-agent models unchanged.')
      return
    }
    const picked = choices.find((c) => c.label === answer)
    const rawSelection = picked ? picked.id : answer
    if (picked && picked.id !== 'inherit') {
      const modelProvider = picked.id.split(':', 1)[0] ?? ''
      await promptProviderBaseUrl(modelProvider, askQuestion, { onlyIfUnset: true })
    }
    if (target === 'all') {
      applyGlobalModel(text, rawSelection)
    } else {
      applyAgentModel(text, target, rawSelection)
    }
  }

  function renderList(text: string, agents: SubAgentDefinition[]): void {
    const mainId = activeMainModelId()
    const config = loadUserConfig()
    const defaultDesc = config.subAgentModel
      ? `**${renderModelLabel(config.subAgentModel)}** (\`${config.subAgentModel}\`)`
      : `inherit (**${renderModelLabel(mainId)}** · \`${mainId}\`)`
    const lines = [`**Sub-Agents** (${agents.length})`, `Default model: ${defaultDesc}`, '']
    for (const agent of agents) {
      lines.push(`- **${agent.name}** _[${formatAgentSource(agent)}]_ — ${formatEffectiveModel(agent)}`)
    }
    lines.push('', 'Configure with `/agent`, `/agent worker <model|inherit>`, or `/agent reset`.')
    addCommandMessage(text, lines.join('\n'))
  }

  async function handleAgent(text: string, arg: string): Promise<void> {
    const registry = options.subAgentRegistry
    if (!registry) {
      addCommandMessage(text, 'Sub-agent system is not initialized.')
      return
    }

    const agents = registry.list()
    const tokens = arg.trim() ? arg.trim().split(/\s+/) : []
    const first = tokens[0]?.toLowerCase() ?? ''

    if (first === 'list' || first === 'status') {
      if (tokens.length > 1) {
        addCommandMessage(text, USAGE_TEXT)
        return
      }
      renderList(text, agents)
      return
    }

    if (first === 'reset') {
      if (tokens.length > 1) {
        addCommandMessage(text, USAGE_TEXT)
        return
      }
      const mainId = activeMainModelId()
      const config = loadUserConfig()
      if (!config.subAgentModel && !config.subAgentModels) {
        addCommandMessage(text, `All sub-agents already inherit main model (**${renderModelLabel(mainId)}**).`)
        return
      }
      const saved = saveUserConfig({ subAgentModel: undefined, subAgentModels: undefined })
      if (!saved) {
        addCommandMessage(text, 'Failed to write `~/.x-code/config.json`.')
        return
      }
      addCommandMessage(text, `Reset all sub-agents to inherit main model (**${renderModelLabel(mainId)}**).`)
      return
    }

    if (first === 'model') {
      if (tokens.length === 1) {
        await pickModelInteractive(text, 'all')
        return
      }
      if (tokens.length === 2) {
        applyGlobalModel(text, tokens[1]!)
        return
      }
      if (tokens.length === 3) {
        const targetName = tokens[1]!
        const target = findAgentByName(agents, targetName)
        if (!target) {
          addCommandMessage(
            text,
            `Unknown sub-agent \`${targetName}\`. Available: ${agents.map((a) => `\`${a.name}\``).join(', ')}.`,
          )
          return
        }
        applyAgentModel(text, target, tokens[2]!)
        return
      }
      addCommandMessage(text, USAGE_TEXT)
      return
    }

    if (tokens.length === 1 || tokens.length === 2) {
      const targetName = tokens[0]!
      const target = findAgentByName(agents, targetName)
      if (!target) {
        addCommandMessage(
          text,
          `${USAGE_TEXT}\nAvailable sub-agents: ${agents.map((a) => `\`${a.name}\``).join(', ')}.`,
        )
        return
      }
      if (tokens.length === 1) {
        await pickModelInteractive(text, target)
      } else {
        applyAgentModel(text, target, tokens[1]!)
      }
      return
    }

    if (tokens.length > 2) {
      addCommandMessage(text, USAGE_TEXT)
      return
    }

    // No args -> interactive two-step picker: choose sub-agent (or All), then choose model.
    const mainId = activeMainModelId()
    const config = loadUserConfig()
    const targetChoices: Array<{ target: SubAgentDefinition | 'all'; label: string; description: string }> = agents.map(
      (agent) => {
        const selection = resolveSubAgentModelSelection(agent, mainId, config)
        const marker = selection.source === 'override' ? `${GLYPH_BULLET} ` : '  '
        const modelSummary =
          selection.source === 'inherit' ? `inherit (${mainId})` : `${selection.modelId} (${selection.source})`
        return {
          target: agent,
          label: `${marker}${agent.name} — ${modelSummary}`,
          description: `[${formatAgentSource(agent)}] ${agent.description}`,
        }
      },
    )
    const allSummary = config.subAgentModel ? `${config.subAgentModel} (default)` : `inherit (${mainId})`
    targetChoices.push({
      target: 'all',
      label: `${config.subAgentModel ? `${GLYPH_BULLET} ` : '  '}All sub-agents (default) — ${allSummary}`,
      description: 'Fallback model for any sub-agent without a per-agent or frontmatter override',
    })

    const targetAnswer = await askQuestion(
      `Main model: ${mainId}\nPick a sub-agent to configure (${GLYPH_BULLET} = custom model set):`,
      targetChoices.map((c) => ({ label: c.label, description: c.description })),
      { noOther: true },
    )
    const pickedTarget = targetChoices.find((c) => c.label === targetAnswer)
    if (!pickedTarget) {
      addCommandMessage(text, 'Cancelled — sub-agent models unchanged.')
      return
    }
    await pickModelInteractive(text, pickedTarget.target)
  }

  return { handleAgent }
}
