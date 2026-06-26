// @x-code-cli/cli — /browser slash command: toggle the browser sub-agent.
//
// Browser automation is opt-in, like every comparable CLI (claude-code's
// --chrome / CLAUDE_CODE_ENABLE_CFC, gemini's settings override, codex's plugin
// install). `/browser on` registers the browser agent in place and persists
// config.browser.enabled; `/browser off` removes it and closes any running
// browser. Both invalidate the system prompt cache because the task tool's
// agent list — part of the byte-stable prefix — just changed.
import { loadUserConfig, saveUserConfig, shutdownBrowserMcp } from '@x-code-cli/core'
import type { AgentOptions } from '@x-code-cli/core'

export interface BrowserCommandDeps {
  options: AgentOptions
  addCommandMessage: (text: string, content: string) => void
  addCommandResult: (content: string) => void
  invalidateSystemPromptCache: () => void
}

export function createBrowserCommandHandler(deps: BrowserCommandDeps) {
  const { options, addCommandMessage, addCommandResult, invalidateSystemPromptCache } = deps

  const isOn = (): boolean => options.subAgentRegistry?.names().includes('browser') ?? false

  async function handleBrowser(text: string, arg: string): Promise<void> {
    const sub = arg.trim().toLowerCase()

    if (sub === '' || sub === 'status') {
      addCommandMessage(
        text,
        isOn()
          ? 'Browser agent is ON. Ask anything that needs a live browser — the model delegates to it automatically. Turn off with /browser off.'
          : 'Browser agent is OFF. Enable with /browser on (needs Node + a browser; first use runs `npx @playwright/mcp`).',
      )
      return
    }

    if (sub !== 'on' && sub !== 'off') {
      addCommandMessage(text, 'Usage: /browser [on|off]')
      return
    }

    if (!options.subAgentRegistry) {
      addCommandMessage(text, "Sub-agent system isn't available, so the browser agent can't be toggled.")
      return
    }

    const enable = sub === 'on'
    if (enable === isOn()) {
      addCommandMessage(text, `Browser agent is already ${enable ? 'ON' : 'OFF'}.`)
      return
    }

    // Persist (merge into any existing browser config so headless/channel
    // overrides survive) so the choice sticks across restarts.
    saveUserConfig({ browser: { ...loadUserConfig().browser, enabled: enable } })
    // Add / remove the browser agent in place — keeps the registry's object
    // identity (captured options.subAgentRegistry refs stay valid) and skips a
    // full custom/plugin re-scan.
    options.subAgentRegistry.setBrowserEnabled(enable)
    // The task tool's agent list (in the byte-stable system prompt) changed.
    invalidateSystemPromptCache()

    if (enable) {
      addCommandMessage(text, 'Browser agent ON — saved.')
      addCommandResult(
        'The model can now delegate live-browser tasks on its own. First use launches the browser via `npx @playwright/mcp` (needs Node + Chrome; ~tens of seconds the first time).\n' +
          'The next message rebuilds the system prompt, so prompt-cache will miss once.',
      )
    } else {
      // Close any running browser MCP subprocess so we don't leak a browser.
      await shutdownBrowserMcp().catch(() => undefined)
      addCommandMessage(text, 'Browser agent OFF — saved.')
      addCommandResult(
        'Closed the browser (if running). The next message rebuilds the system prompt, so prompt-cache will miss once.',
      )
    }
  }

  return { handleBrowser }
}
