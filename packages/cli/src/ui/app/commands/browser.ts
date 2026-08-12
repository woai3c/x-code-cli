// @x-code-cli/cli — /browser slash command: toggle the interactive browser agent.
//
// Interactive browser automation is opt-in, like every comparable CLI (claude-code's
// --chrome / CLAUDE_CODE_ENABLE_CFC, gemini's settings override, codex's plugin
// install). `/browser on|off` controls the browser agent; `/browser check-on`
// and `/browser check-off` control the independent one-shot local visual check.
// The shared browser closes only when both consumers are off.
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
  const isVisualCheckOn = (): boolean => options.browserVisualCheckEnabled !== false

  async function handleBrowser(text: string, arg: string): Promise<void> {
    const sub = arg.trim().toLowerCase()

    if (sub === '' || sub === 'status') {
      addCommandMessage(
        text,
        `Interactive Browser Use is ${isOn() ? 'ON' : 'OFF'}; automatic local visual checks are ${isVisualCheckOn() ? 'ON' : 'OFF'}.`,
      )
      return
    }

    if (sub !== 'on' && sub !== 'off' && sub !== 'check-on' && sub !== 'check-off') {
      addCommandMessage(text, 'Usage: /browser [on|off|check-on|check-off]')
      return
    }

    if (sub === 'check-on' || sub === 'check-off') {
      const enable = sub === 'check-on'
      if (enable === isVisualCheckOn()) {
        addCommandMessage(text, `Automatic local visual checks are already ${enable ? 'ON' : 'OFF'}.`)
        return
      }

      saveUserConfig({ browser: { ...loadUserConfig().browser, visualCheck: enable } })
      options.browserVisualCheckEnabled = enable
      invalidateSystemPromptCache()

      if (!enable && !isOn()) await shutdownBrowserMcp().catch(() => undefined)
      addCommandMessage(text, `Automatic local visual checks ${enable ? 'ON' : 'OFF'} — saved.`)
      addCommandResult(
        enable
          ? 'The root agent can now capture one temporary-tab screenshot of localhost after significant visual changes. Browser Use remains independently controlled by /browser on.'
          : `The root visual-check tool is disabled.${isOn() ? ' The managed browser remains open for interactive Browser Use.' : ' Closed the managed browser (if running).'}`,
      )
      return
    }

    if (!options.subAgentRegistry) {
      addCommandMessage(text, "Sub-agent system isn't available, so the browser agent can't be toggled.")
      return
    }

    const enable = sub === 'on'
    if (enable === isOn()) {
      addCommandMessage(text, `Interactive browser agent is already ${enable ? 'ON' : 'OFF'}.`)
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
      addCommandMessage(text, 'Interactive browser agent ON — saved.')
      addCommandResult(
        'The model can now delegate clicking, typing, login, and other multi-step browser tasks. It reuses the managed Chrome used by visual checks; no extension is required. First browser use launches it via `npx @playwright/mcp` (needs Node + Chrome; ~tens of seconds the first time).\n' +
          'The next message rebuilds the system prompt, so prompt-cache will miss once.',
      )
    } else {
      if (!isVisualCheckOn()) await shutdownBrowserMcp().catch(() => undefined)
      addCommandMessage(text, 'Interactive browser agent OFF — saved.')
      addCommandResult(
        `${isVisualCheckOn() ? 'The managed browser stays available for automatic local visual checks.' : 'Closed the managed browser (if running).'} The next message rebuilds the system prompt, so prompt-cache will miss once.`,
      )
    }
  }

  return { handleBrowser }
}
