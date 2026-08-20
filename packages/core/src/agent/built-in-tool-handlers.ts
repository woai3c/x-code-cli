import { truncateToolResult } from '../tools/index.js'
import { reportProgress } from '../tools/progress.js'
import { debugLog, isAbortError } from '../utils.js'
import { markExpectedCacheMiss } from './cache-stats.js'
import { toolErrorFromUnknown, toolErrorString } from './messages.js'
import { runSubAgent } from './sub-agents/runner.js'
import type { PushToolResult, ToolHandler, ToolHandlerContext } from './tool-handler-context.js'
import { runToolSearch } from './tool-search/resolve.js'

/** Build the self-contained handlers that bypass the standard write/shell pipeline. */
export function createBuiltInToolHandlers(pushToolResult: PushToolResult): Record<string, ToolHandler> {
  const handleAskUser = async (context: ToolHandlerContext): Promise<void> => {
    const { input, toolCallId, toolName, state, callbacks } = context
    const question = input.question as string
    const options = input.options as { label: string; description: string }[]
    const answer = await callbacks.onAskUser(question, options)
    pushToolResult(state, callbacks, toolCallId, toolName, `User answered: ${answer}`)
  }

  const handleTask = async (context: ToolHandlerContext): Promise<void> => {
    const { input, toolCallId, toolName, state, options, callbacks, parentModel } = context
    const agentName = input.subagent_type as string
    const description = input.description as string
    const taskPrompt = input.prompt as string

    reportProgress(toolCallId, `Task: ${description} (${agentName})`)
    const result = await runSubAgent(
      {
        parentState: state,
        parentOptions: options,
        callbacks,
        toolCallId,
        agentName,
        description,
        prompt: taskPrompt,
        knowledgeContext: state.knowledgeContext ?? '',
        isGitRepo: state.isGitRepo ?? false,
      },
      parentModel,
      context.runSubAgentLoop,
    )

    const statsLine = `<task_stats tool_calls="${result.toolCallCount}" tokens="${result.tokenUsage.totalTokens}" duration_ms="${result.durationMs}" />`
    pushToolResult(
      state,
      callbacks,
      toolCallId,
      toolName,
      `${result.resultText}\n${statsLine}`,
      result.cleanupFailed === true,
    )
  }

  const handleListMcpResources = async (context: ToolHandlerContext): Promise<void> => {
    const { input, toolCallId, toolName, state, options, callbacks } = context
    const registry = options.mcpRegistry
    if (!registry) {
      pushToolResult(state, callbacks, toolCallId, toolName, toolErrorString('MCP not configured'), true)
      return
    }
    const filter = (input.server as string | undefined)?.trim() || undefined
    const items = registry.listResources().filter((resource) => !filter || resource.serverName === filter)
    if (items.length === 0) {
      pushToolResult(
        state,
        callbacks,
        toolCallId,
        toolName,
        filter ? `No resources on server "${filter}".` : 'No resources from any connected MCP server.',
      )
      return
    }
    const lines = items.map((resource) => {
      const mime = resource.mimeType ? ` (${resource.mimeType})` : ''
      const description = resource.description ? `\n    ${resource.description}` : ''
      return `${resource.uri}\t[${resource.serverName}] ${resource.name}${mime}${description}`
    })
    pushToolResult(state, callbacks, toolCallId, toolName, lines.join('\n'))
  }

  const handleReadMcpResource = async (context: ToolHandlerContext): Promise<void> => {
    const { input, toolCallId, toolName, state, options, callbacks } = context
    const registry = options.mcpRegistry
    if (!registry) {
      pushToolResult(state, callbacks, toolCallId, toolName, toolErrorString('MCP not configured'), true)
      return
    }
    const uri = (input.uri as string | undefined) ?? ''
    if (!uri) {
      pushToolResult(state, callbacks, toolCallId, toolName, toolErrorString('Missing `uri` argument'), true)
      return
    }
    const client = registry.resourceServer(uri)
    if (!client) {
      pushToolResult(
        state,
        callbacks,
        toolCallId,
        toolName,
        toolErrorString(`Resource URI not known: ${uri} — call listMcpResources first`),
        true,
      )
      return
    }
    reportProgress(toolCallId, `Reading ${uri}`)
    try {
      const result = await client.readResource(uri, options.abortSignal)
      pushToolResult(state, callbacks, toolCallId, toolName, truncateToolResult(result.text))
    } catch (error) {
      if (isAbortError(error, options.abortSignal)) {
        pushToolResult(state, callbacks, toolCallId, toolName, '[Tool execution interrupted by user]', true)
        return
      }
      pushToolResult(state, callbacks, toolCallId, toolName, toolErrorFromUnknown(error), true)
    }
  }

  const handleToolSearch = async (context: ToolHandlerContext): Promise<void> => {
    const { input, toolCallId, toolName, state, callbacks } = context
    const catalog = state.deferredCatalog ?? []
    const query = (input.query as string | undefined)?.trim() ?? ''
    if (!query) {
      pushToolResult(
        state,
        callbacks,
        toolCallId,
        toolName,
        toolErrorString('toolSearch requires a non-empty query.'),
        true,
      )
      return
    }
    const requested = Number(input.max_results)
    const maxResults = Number.isFinite(requested) ? Math.min(50, Math.max(1, Math.floor(requested))) : 5
    const pendingServers = context.options.mcpRegistry
      ?.serverStatus()
      .filter((server) => server.status.kind === 'connecting')
      .map((server) => server.name)
    const result = runToolSearch(query, maxResults, catalog, pendingServers)
    debugLog(
      'tool-search',
      `queryBytes=${Buffer.byteLength(query, 'utf8')} max=${maxResults} catalog=${catalog.length} → [${result.activated.join(', ')}]`,
    )

    let added = false
    let anyAlreadyActive = false
    for (const name of result.activated) {
      if (state.activatedTools.has(name)) {
        anyAlreadyActive = true
      } else {
        state.activatedTools.add(name)
        added = true
      }
    }
    if (added) markExpectedCacheMiss(state, 'tool-activation')

    const text =
      !added && anyAlreadyActive
        ? `Already loaded — call ${result.activated.join(', ')} directly now. No need to search again.`
        : result.text
    pushToolResult(state, callbacks, toolCallId, toolName, text)
  }

  const handleListAgents = async (context: ToolHandlerContext): Promise<void> => {
    const { options, state, callbacks, toolCallId, toolName } = context
    if (!options.peerService?.enabled) {
      pushToolResult(state, callbacks, toolCallId, toolName, toolErrorString('Peer messaging is disabled'), true)
      return
    }
    try {
      const peers = await options.peerService.listAgents(options.abortSignal)
      pushToolResult(state, callbacks, toolCallId, toolName, JSON.stringify({ agents: peers }))
    } catch (error) {
      pushToolResult(state, callbacks, toolCallId, toolName, toolErrorFromUnknown(error), true)
    }
  }

  const handleSendMessage = async (context: ToolHandlerContext): Promise<void> => {
    const { options, state, callbacks, toolCallId, toolName } = context
    if (!options.peerService?.enabled || !context.preparedPeerSend) {
      pushToolResult(
        state,
        callbacks,
        toolCallId,
        toolName,
        toolErrorString('Peer message was not safely prepared'),
        true,
      )
      return
    }
    const result = await options.peerService.sendPrepared(context.preparedPeerSend, options.abortSignal)
    pushToolResult(state, callbacks, toolCallId, toolName, JSON.stringify(result), !result.success)
  }

  return {
    askUser: handleAskUser,
    task: handleTask,
    listMcpResources: handleListMcpResources,
    readMcpResource: handleReadMcpResource,
    toolSearch: handleToolSearch,
    listAgents: handleListAgents,
    sendMessage: handleSendMessage,
  }
}
