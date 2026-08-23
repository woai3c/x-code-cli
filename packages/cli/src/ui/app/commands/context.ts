import {
  MIN_CONTEXT_WINDOW_OVERRIDE,
  getContextWindow,
  getContextWindowOverride,
  saveUserConfig,
  setContextWindowOverride,
} from '@x-code-cli/core'

export interface ContextCommandDeps {
  modelId: string
  addCommandMessage: (text: string, content: string) => void
}

export function parseContextWindowSize(argument: string): number | null {
  const match = /^(\d+(?:\.\d+)?|\d{1,3}(?:,\d{3})+|\d{1,3}(?:_\d{3})+)([km]?)$/i.exec(argument.trim())
  if (!match) return null

  const multiplier = match[2]?.toLowerCase() === 'm' ? 1_000_000 : match[2]?.toLowerCase() === 'k' ? 1_000 : 1
  const value = Number(match[1]?.replace(/[,_]/g, '')) * multiplier
  return Number.isSafeInteger(value) && value >= MIN_CONTEXT_WINDOW_OVERRIDE ? value : null
}

function formatTokens(tokens: number): string {
  return tokens.toLocaleString('en-US')
}

export function createContextCommandHandler({ modelId, addCommandMessage }: ContextCommandDeps) {
  function handleContext(text: string, argument: string): void {
    const normalized = argument.trim().toLowerCase()
    const currentOverride = getContextWindowOverride()

    if (normalized === '') {
      addCommandMessage(
        text,
        currentOverride === undefined
          ? `No context window override is set. Models use their detected/default sizes (**${formatTokens(getContextWindow(modelId))} tokens** for \`${modelId}\`).`
          : `Context window override is **${formatTokens(currentOverride)} tokens** for every model. Run \`/context reset\` to restore model defaults.`,
      )
      return
    }

    if (normalized === 'reset') {
      const saved = saveUserConfig({ contextWindow: undefined })
      setContextWindowOverride(undefined)
      addCommandMessage(
        text,
        `Context window override cleared — \`${modelId}\` now uses its detected/default **${formatTokens(getContextWindow(modelId))}-token** window.${saved ? '' : ' The runtime override is cleared, but config.json could not be updated; it may return after restart.'}`,
      )
      return
    }

    const contextWindow = parseContextWindowSize(argument)
    if (contextWindow === null) {
      addCommandMessage(
        text,
        `Usage: /context [tokens|reset] (minimum ${formatTokens(MIN_CONTEXT_WINDOW_OVERRIDE)}; examples: \`/context 128000\`, \`/context 128k\`, \`/context 1m\`)`,
      )
      return
    }

    const saved = saveUserConfig({ contextWindow })
    setContextWindowOverride(contextWindow)
    addCommandMessage(
      text,
      saved
        ? `Context window forced to **${formatTokens(contextWindow)} tokens** for every model — saved. Takes effect on the next message.`
        : `Context window forced to **${formatTokens(contextWindow)} tokens** for every model in this session, but config.json could not be updated. Takes effect on the next message.`,
    )
  }

  return { handleContext }
}
