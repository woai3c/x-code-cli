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
export { KEEP_RECENT } from './agent/compression.js'
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
export {
  extractCommandPrefix,
  extractCompoundPrefixes,
  extractCompoundRules,
  suggestRuleLabel,
} from './permissions/index.js'
export { loadPersistedRules, persistRule } from './permissions/index.js'
export type { AllowRule } from './permissions/session-store.js'

// Utils
export { USER_XCODE_DIR, XCODE_DIR, debugLog, setPluginDebugMirror } from './utils.js'
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

// File-based slash commands (plugin-contributed `commands/*.md`).
export { CommandRegistry, createCommandRegistry, loadPluginCommands, expandCommandBody } from './commands/index.js'
export type { CommandDefinition, LoadCommandsOptions } from './commands/index.js'

// Hooks — agent lifecycle event subsystem driven by plugin contributions.
export {
  HookBus,
  emptyHookBus,
  aggregatePreToolUse,
  aggregatePostToolUse,
  aggregateUserPromptSubmit,
} from './hooks/bus.js'
export type { EmitOptions as HookEmitOptions, PreToolEffect, PostToolEffect, UserPromptEffect } from './hooks/bus.js'
export { HookRegistry, buildHookRegistry, emptyHookRegistry } from './hooks/registry.js'
export { executeHook } from './hooks/executor.js'
export type { ExecuteHookOptions } from './hooks/executor.js'
export { hookConfigSchema, parseHookConfig, HookConfigParseError } from './hooks/config-schema.js'
export { buildVariableContext, expandVariables } from './hooks/variables.js'
export type { VariableContext } from './hooks/variables.js'
export type {
  DecisionEvent,
  HookConfig,
  HookConfigEntry,
  HookDecision,
  HookEvent,
  HookEventName,
  RegisteredHook,
  SessionContext as HookSessionContext,
} from './hooks/types.js'

// Plugins — discovery, install, marketplace, registry.
export { loadAllPlugins, resolveContributions } from './plugins/loader.js'
export type {
  LoadOptions as PluginLoadOptions,
  LoadResult as PluginLoadResult,
  ResolvedContributions,
} from './plugins/loader.js'
export { PluginRegistry, emptyPluginRegistry } from './plugins/registry.js'
export type { PluginReloadSummary } from './plugins/registry.js'
export {
  buildPluginIntegration,
  debugLogIntegrationDiagnostics,
  getPluginMcpServersFromDisk,
} from './plugins/integration.js'
export type { PluginIntegrationOutput } from './plugins/integration.js'
export { refreshPluginContributions } from './plugins/refresh.js'
export type { PluginRefreshSummary, PluginRefreshTargets } from './plugins/refresh.js'
export {
  installPlugin,
  uninstallPlugin,
  listInstalledPlugins,
  findInstalledPlugin,
  InstallError,
} from './plugins/installer.js'
export type { InstallRequest, InstallResult, UninstallResult } from './plugins/installer.js'
export { buildConsentPreview, probePluginRoot } from './plugins/consent.js'
export type { ConsentPreview, BuildPreviewInput, RootProbe } from './plugins/consent.js'
export {
  getPluginUserConfig,
  setPluginUserConfig,
  clearPluginUserConfig,
  getPluginUserConfigEnv,
} from './plugins/user-config.js'
export type { UserConfigValue, PluginUserConfig } from './plugins/user-config.js'
export {
  parseMarketplace,
  readKnownMarketplaces,
  addKnownMarketplace,
  removeKnownMarketplace,
  ensureDefaultMarketplaces,
  fetchMarketplace,
  readAllCachedMarketplaces,
  lookupPlugin,
  resolveCloneUrl,
  RESERVED_MARKETPLACE_NAMES,
  MarketplaceParseError,
} from './plugins/marketplace.js'
export {
  EnableState,
  setPluginEnabled,
  clearPluginEntry,
  settingsPathForScope as pluginSettingsPathForScope,
} from './plugins/enable-state.js'
export type { ResolvedEnableState } from './plugins/enable-state.js'
export type {
  LoadedPlugin,
  PluginManifest,
  PluginAuthor,
  UserConfigItem,
  PluginSource,
  PluginScope,
  ManifestFormat,
  PluginLoadError,
  Marketplace,
  MarketplaceEntry,
  KnownMarketplace,
  KnownMarketplaces,
  InstalledPluginRecord,
  InstalledPlugins,
} from './plugins/types.js'
export { discoverManifest, parseManifest, ManifestParseError } from './plugins/manifest.js'

// Skills
export {
  SkillRegistry,
  createSkillRegistry,
  reloadSkillRegistry,
  formatSkillActivationBody,
  wrapActivatedSkill,
} from './skills/registry.js'
export type { SkillDefinition, SkillEntry, SkillReloadSummary } from './skills/registry.js'
export { getScopedDisabledSkills, setSkillDisabled, skillSettingsPath } from './skills/settings.js'
export type { SkillSettingsScope } from './skills/settings.js'

// Session store (per-session jsonl transcript — used by /resume,
// /usage history, and the CLI startup --resume / --continue flags).
export {
  appendCheckpoint,
  appendInterrupted,
  flushPendingMessages,
  getSessionFilePath,
  hydrateLoopState,
  listSessions,
  loadSession,
  markBoundaryAndReflush,
  pickLatestSession,
} from './agent/session-store.js'
export type { LoadedSession, SessionListEntry } from './agent/session-store.js'

// Rewind snapshots — file-history backing for /rewind.
export { createCheckpoint, restoreCheckpoint } from './agent/snapshot.js'
export type { CheckpointEntry } from './agent/snapshot.js'

// MCP — Model Context Protocol client support.
export { McpRegistry, emptyRegistry } from './mcp/registry.js'
export type {
  RegisteredServer,
  RestartSummary as McpRestartSummary,
  AuthHooks as McpAuthHooks,
  ConnectResult as McpConnectResult,
  OAuthProviderFactory,
} from './mcp/registry.js'
export { loadMcpServers, loadMcpFromDisk, loadMergedConfigsFromDisk } from './mcp/loader.js'
export type { LoadOptions as McpLoadOptions, LoadResult as McpLoadResult } from './mcp/loader.js'
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
export { buildCallableName, MCP_MAX_NAME_LEN } from './mcp/name-mangling.js'
export { expandEnvDeep, expandEnvString, EnvExpansionError } from './mcp/expand-env.js'
export { parseServersBlock, parseServerConfig, mcpServersSchema } from './mcp/config-schema.js'
export { parseAdd, parseAddJson, parseRemove, tokenize } from './mcp/arg-parser.js'
export type {
  AddCommand,
  AddJsonCommand,
  RemoveCommand,
  ParsedCommand,
  ParseResult,
  ConfigScope,
} from './mcp/arg-parser.js'
export {
  detectScope,
  getConfigPath as getMcpConfigPath,
  readServerConfig,
  removeServerFromConfig,
  serverExists,
  writeServerToConfig,
} from './mcp/config-writer.js'
export type { DetectScopeResult } from './mcp/config-writer.js'
