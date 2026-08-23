import { errorMessage, expandCommandBody, wrapActivatedSkill } from '@x-code-cli/core'
import type { AgentOptions, SkillDefinition } from '@x-code-cli/core'

import type { useAgent } from '../../agent/use-agent.js'
import { INIT_PROMPT, REVIEW_PROMPT, buildHelpText } from '../command-content.js'
import { formatBackgroundTerminals, formatStopResult } from './background-terminal.js'

type AgentController = ReturnType<typeof useAgent>
type AsyncHandler = (commandText: string, argument: string) => Promise<void>

interface SlashCommandHandlers {
  login: AsyncHandler
  logout: AsyncHandler
  model: AsyncHandler
  context: (commandText: string, argument: string) => void
  thinking: AsyncHandler
  theme: AsyncHandler
  plan: (commandText: string, argument: string) => void
  compact: () => Promise<void>
  goal: (argument: string) => Promise<void>
  resume: () => Promise<void>
  rewind: (argument: string) => Promise<void>
  usage: () => Promise<void>
  usageHistory: () => Promise<void>
  memory: (argument: string) => Promise<void>
  skill: AsyncHandler
  mcp: AsyncHandler
  plugin: AsyncHandler
  browser: AsyncHandler
  doctor: (commandText: string) => void
}

interface SlashCommandRouterOptions {
  agent: Pick<
    AgentController,
    | 'addCommandMessage'
    | 'addCommandResult'
    | 'addInfoMessage'
    | 'clear'
    | 'clearPeerContext'
    | 'echoCommand'
    | 'fork'
    | 'listShellSessions'
    | 'stopShellSessions'
    | 'submit'
  >
  options: Pick<AgentOptions, 'peerService' | 'skillRegistry' | 'commandRegistry'>
  skillCommands: readonly { name: string; description: string }[]
  fileCommands: readonly { name: string; description?: string }[]
  pendingSkillRef: { current: SkillDefinition | null }
  handlers: SlashCommandHandlers
  exit: () => void
}

/** Route one slash command. Busy-state admission remains owned by App. */
export async function routeSlashCommand(text: string, router: SlashCommandRouterOptions): Promise<void> {
  const parts = text.slice(1).trim().split(/\s+/)
  const command = parts[0]?.toLowerCase() ?? ''
  const argument = parts.slice(1).join(' ')
  const { agent, handlers } = router

  switch (command) {
    case 'help':
      agent.echoCommand(text)
      agent.addInfoMessage(buildHelpText(router.skillCommands, router.fileCommands))
      return

    case 'login':
      await handlers.login(text, argument)
      return

    case 'logout':
      await handlers.logout(text, argument)
      return

    case 'model':
      void handlers.model(text, argument)
      return

    case 'context':
      handlers.context(text, argument)
      return

    case 'thinking':
      void handlers.thinking(text, argument)
      return

    case 'theme':
      await handlers.theme(text, argument)
      return

    case 'plan':
      handlers.plan(text, argument)
      return

    case 'clear': {
      router.pendingSkillRef.current = null
      const result = await agent.clear(text)
      if (!result.ok) {
        agent.addCommandMessage(
          text,
          `Clear was not completed: ${result.reason}.${result.result ? `\n${formatStopResult(result.result)}` : ''}`,
        )
      }
      return
    }

    case 'ps':
      agent.echoCommand(text)
      agent.addCommandResult(formatBackgroundTerminals(agent.listShellSessions()))
      return

    case 'stop':
      agent.echoCommand(text)
      try {
        agent.addCommandResult(formatStopResult(await agent.stopShellSessions(argument.trim() || undefined)))
      } catch (error) {
        agent.addCommandResult(`Unable to stop background terminal: ${errorMessage(error)}`)
      }
      return

    case 'clear-peer-context': {
      agent.echoCommand(text)
      const result = await agent.clearPeerContext()
      agent.addInfoMessage(
        result.ok
          ? result.removed > 0
            ? `Removed ${result.removed} peer-influenced transcript message(s).`
            : 'No peer-influenced context is active.'
          : `Peer context was not cleared: ${result.reason ?? 'unknown error'}`,
      )
      return
    }

    case 'list-agents': {
      agent.echoCommand(text)
      const service = router.options.peerService
      if (!service?.enabled) {
        agent.addCommandResult('This session is not a named agent. Restart with --name <name> to enable communication.')
        return
      }
      if (!service.isAvailable()) {
        agent.addCommandResult(`Peer messaging unavailable: ${service.getUnavailableReason() ?? 'service not running'}`)
        return
      }
      try {
        const { peers, partial } = await service.list()
        peers.sort(
          (left, right) => left.startedAt.localeCompare(right.startedAt) || left.name.localeCompare(right.name),
        )
        agent.addCommandResult(
          peers.length === 0
            ? 'No other reachable X-Code sessions.'
            : `${peers
                .map(
                  (peer) =>
                    `${peer.name} · ${peer.address} · ${peer.status}${peer.busyKind ? ` (${peer.busyKind})` : ''} · ${peer.cwd}`,
                )
                .join('\n')}${partial ? '\nResults may be partial because discovery reached its deadline.' : ''}`,
        )
      } catch (error) {
        agent.addCommandResult(`Unable to list agents: ${errorMessage(error)}`)
      }
      return
    }

    case 'compact':
      agent.echoCommand(text)
      await handlers.compact()
      return

    case 'goal':
      agent.echoCommand(text)
      await handlers.goal(argument)
      return

    case 'resume':
      agent.echoCommand(text)
      await handlers.resume()
      return

    case 'fork': {
      agent.echoCommand(text)
      const name = argument.trim() || undefined
      const result = await agent.fork(name)
      if (!result.ok) {
        agent.addCommandResult(`Fork failed: ${result.reason}`)
        return
      }
      const boundary = result.excludedActiveTurn
        ? 'The active request remains only in the original session.'
        : 'Copied all completed conversation context.'
      const title = name ? `**${name}** (\`${result.sessionId}\`)` : `**${result.sessionId}**`
      const resumeKey = name ? `"${name}"` : result.sessionId
      agent.addCommandResult(
        `Fork created: ${title} (${result.messageCount} messages).\n\n${boundary}\n\nThe conversation is independent, but both sessions still share this working tree. Avoid concurrent edits to the same files.\n\nOpen another terminal:\n\n\`xc --resume ${resumeKey}\``,
      )
      return
    }

    case 'rewind':
      agent.echoCommand(text)
      await handlers.rewind(argument)
      return

    case 'init':
      agent.echoCommand(text)
      await agent.submit(INIT_PROMPT, { silent: true })
      return

    case 'review':
      agent.echoCommand(text)
      await agent.submit(REVIEW_PROMPT(argument), { silent: true })
      return

    case 'usage':
      agent.echoCommand(text)
      await handlers.usage()
      return

    case 'usage-history':
      agent.echoCommand(text)
      await handlers.usageHistory()
      return

    case 'memory':
      agent.echoCommand(text)
      await handlers.memory(argument)
      return

    case 'skill':
      await handlers.skill(text, argument)
      return

    case 'mcp':
      await handlers.mcp(text, argument)
      return

    case 'plugin':
      await handlers.plugin(text, argument)
      return

    case 'browser':
      await handlers.browser(text, argument)
      return

    case 'doctor':
      handlers.doctor(text)
      return

    case 'exit':
      router.exit()
      return
  }

  const skill = router.options.skillRegistry?.get(command)
  if (skill) {
    if (argument) {
      agent.echoCommand(text)
      await agent.submit(`${wrapActivatedSkill(skill)}\n\n${argument}`, { silent: true })
    } else {
      router.pendingSkillRef.current = skill
      agent.addCommandMessage(text, `Skill **${skill.name}** loaded. Type your request.`)
    }
    return
  }

  const fileCommand = router.options.commandRegistry?.get(command)
  if (fileCommand) {
    agent.echoCommand(text)
    await agent.submit(expandCommandBody(fileCommand, argument), { silent: true })
    return
  }
  agent.addCommandMessage(text, `Unknown command: /${command}. Type /help for available commands.`)
}
