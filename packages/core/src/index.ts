// @x-code-cli/core — Public API exports

// Types
export type {
  PermissionLevel,
  PermissionMode,
  TokenUsage,
  TodoItem,
  TodoStatus,
  DisplayMessage,
  DisplayToolCall,
  AgentCallbacks,
  AgentOptions,
  KnowledgeCategory,
  KnowledgeFact,
  SessionSummary,
  ModelMessage,
  LanguageModel,
} from './types/index.js'

export { MODEL_ALIASES, PROVIDER_DETECTION_ORDER, PROVIDER_KEY_URLS, PROVIDER_MODELS } from './types/index.js'
export type { ProviderModel } from './types/index.js'

// Config
export { resolveModelId, getAvailableProviders, getEnvVarName, loadUserConfig, saveUserConfig } from './config/index.js'
export type { UserConfig } from './config/index.js'

// Provider Registry
export { createModelRegistry } from './providers/registry.js'

// Agent
export { agentLoop, saveSession, compressMessages } from './agent/loop.js'
export type { LoopState } from './agent/loop.js'
export { computeEditDiff } from './agent/diff.js'
export type { EditDiffHunk, EditDiffPayload } from './agent/diff.js'
export { buildSystemPrompt, buildSubAgentSystemPrompt } from './agent/system-prompt.js'
export { makePlanFilePath } from './agent/plan-storage.js'
export {
  COMPRESSION_TRIGGER_RATIO,
  estimateTokenCount,
  getCompressionThreshold,
  getContextWindow,
} from './agent/context-window.js'
export { classifyApiError } from './agent/api-errors.js'
export { buildUserContent, extractFileReferences, ingestFile, classifyFile } from './agent/file-ingest.js'
export type { FileKind, FileReference, IngestedPart } from './agent/file-ingest.js'
export { captionImage, pickVisionProvider } from './agent/vision-fallback.js'
export type { VisionProvider } from './agent/vision-fallback.js'

// Provider capabilities
export { capabilitiesOf, providerOf } from './providers/capabilities.js'
export type { ProviderCapabilities } from './providers/capabilities.js'

// Tools
export { toolRegistry, truncateToolResult } from './tools/index.js'
export { getShellProvider } from './tools/shell-provider.js'
export type { ShellProvider, ShellType } from './tools/shell-provider.js'

// Permissions
export { checkPermission, getPermissionLevel } from './permissions/index.js'
export { addSessionAllowRule, clearSessionRules, buildAllowRule } from './permissions/index.js'
export { extractCommandPrefix, suggestRuleLabel } from './permissions/index.js'
export { loadPersistedRules, persistRule } from './permissions/index.js'
export type { AllowRule } from './permissions/session-store.js'

// Utils
export { GLOBAL_XCODE_DIR, XCODE_DIR, debugLog } from './utils.js'
export { LruCache } from './utils/lru-cache.js'
export { mediaTypeFor } from './utils/media-type.js'
export { extractText } from './utils/message-helpers.js'

// Knowledge
export { buildKnowledgeContext } from './knowledge/loader.js'
export { getAutoMemory, initMemories } from './knowledge/auto-memory.js'
export { generateSessionSummary } from './knowledge/session.js'

// Sub-agents
export { createSubAgentRegistry, createBuiltInRegistry, SubAgentRegistry } from './agent/sub-agents/index.js'
export type { SubAgentDefinition, SubAgentEvent, SubAgentTrace } from './agent/sub-agents/index.js'

// Session store (per-session jsonl transcript — used by /resume,
// /usage history, and the CLI startup --resume / --continue flags).
export {
  appendInterrupted,
  flushPendingMessages,
  getSessionFilePath,
  hydrateLoopState,
  listSessions,
  loadSession,
  pickLatestSession,
} from './agent/session-store.js'
export type { LoadedSession, SessionListEntry } from './agent/session-store.js'

// MCP — Model Context Protocol client support.
export { McpRegistry, emptyRegistry } from './mcp/registry.js'
export type { RegisteredServer } from './mcp/registry.js'
export { loadMcpServers, loadMcpFromDisk } from './mcp/loader.js'
export type { LoadOptions as McpLoadOptions, LoadResult as McpLoadResult, OAuthProviderFactory } from './mcp/loader.js'
export { McpPermissionStore, classifyDecision } from './mcp/permissions.js'
export type { McpPermissionDecision } from './mcp/permissions.js'
export { isProjectTrusted, trustProject, promptForTrust, buildServerPreview } from './mcp/trust.js'
export type { TrustChoice } from './mcp/trust.js'
export { McpTokenStorage, getTokenStorage, setTokenStorageForTesting } from './mcp/oauth/token-storage.js'
export type { StoredServerAuth } from './mcp/oauth/token-storage.js'
export { McpOAuthProvider, createOAuthProviderFactory } from './mcp/oauth/provider.js'
export { startCallbackServer } from './mcp/oauth/callback-server.js'
export type { McpServerConfig, McpServerStatus, McpToolEntry, McpResourceEntry, McpCallResult } from './mcp/types.js'
export { isStdioConfig, isHttpConfig } from './mcp/types.js'
export { buildCallableName, isMcpCallableName, MCP_PREFIX } from './mcp/name-mangling.js'
export { expandEnvDeep, expandEnvString, EnvExpansionError } from './mcp/expand-env.js'
export { parseServersBlock, parseServerConfig, mcpServersSchema } from './mcp/config-schema.js'
