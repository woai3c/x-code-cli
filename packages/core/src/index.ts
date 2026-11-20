// @x-code-cli/core — Public API exports

export { VERSION } from './version.js'

// Types
export type {
  PermissionDecision,
  PermissionLevel,
  PermissionMode,
  TokenSpeedUpdate,
  TokenUsage,
  DisplayMessage,
  DisplayToolCall,
  AgentCallbacks,
  AgentOptions,
  StreamRetryEvent,
  ModelMessage,
  LanguageModel,
  ExecutionAuthority,
  AuthorityApproval,
  AuthorityApprovalPreview,
  ToolCapability,
  PublicPeer,
  QueuedAgentInput,
  TrackedModelMessage,
  ContextSecurityState,
  MessageProvenance,
  PeerOriginSummary,
} from './types/index.js'

export {
  MODEL_ALIASES,
  PROVIDER_BASE_URLS,
  PROVIDER_DETECTION_ORDER,
  PROVIDER_KEY_URLS,
  PROVIDER_MODELS,
  PROVIDERS,
} from './providers/catalog.js'
export type { ProviderModel } from './providers/catalog.js'

// Config
export {
  DEFAULT_MEMORY_CONFIG,
  DEFAULT_PEER_MESSAGING_CONFIG,
  DEFAULT_STREAM_CONFIG,
  normalizeSubAgentModelSpec,
  resolveMemoryConfig,
  resolvePeerMessagingConfig,
  resolveStreamConfig,
  resolveModelId,
  resolveSubAgentModelSelection,
  getAvailableProviders,
  getEnvVarName,
  loadUserConfig,
  saveUserConfig,
} from './config/index.js'

// OpenAI authentication
export {
  getOpenAIAuthContext,
  getOpenAIAuthSnapshot,
  getOpenAIAuthStatus,
  initializeOpenAIAuthContext,
  refreshOpenAIAuthContextIfChanged,
  refreshOpenAIAuthSnapshot,
  resetOpenAIAuthContextForTesting,
} from './auth/openai-chatgpt/auth-resolver.js'
export type { OpenAIAuthSnapshot } from './auth/openai-chatgpt/auth-resolver.js'
export {
  clearOpenAIChatGPTCredentials,
  hasOpenAIChatGPTCredentials,
  readOpenAIChatGPTCredentials,
  withOpenAIChatGPTCredentialLock,
  writeOpenAIChatGPTCredentials,
} from './auth/openai-chatgpt/credential-store.js'
export {
  loginOpenAIChatGPTWithBrowser,
  loginOpenAIChatGPTWithDevice,
  revokeOpenAIChatGPTCredentials,
} from './auth/openai-chatgpt/oauth.js'
export type { OpenAIAuthContext, OpenAIAuthStatus, OpenAIChatGPTCredentials } from './auth/openai-chatgpt/types.js'
export type { MemoryConfig, MemoryReasoningMode, PeerMessagingConfig } from './config/index.js'

// Provider Registry
export { createModelRegistry } from './providers/registry.js'
export {
  getOpenAIChatGPTModelCatalogState,
  getProviderModels,
  refreshOpenAIChatGPTModels,
} from './providers/openai-chatgpt-models.js'

// Agent
export {
  agentLoop,
  compressMessagesWithUsage,
  drainQueuedInputs,
  formatQueuedAgentInput,
  saveSession,
} from './agent/loop.js'
export { compressTrackedMessagesWithUsage } from './agent/context/compression.js'
export type { AgentLoopResult } from './agent/loop.js'
export { createLoopState } from './agent/loop-state.js'
export {
  deriveContextSecurity,
  effectiveExecutionAuthority,
  mergePeerOriginSummaries,
  summarizePeerOrigins,
} from './agent/provenance.js'
export { KEEP_RECENT_TOKENS, MIN_KEEP_MESSAGES } from './agent/context/compression.js'
export type { LoopState } from './agent/loop.js'
export type { StepStats } from './agent/loop-state.js'
export {
  consumeExpectedCacheMissReasons,
  createProviderTurnUsage,
  estimateCacheMiss,
  markExpectedCacheMiss,
  scanCacheMisses,
} from './agent/cache-stats.js'
export type { CacheMissReason, CacheMissSummary, ProviderTurnUsage } from './agent/cache-stats.js'
export {
  accumulateUsage,
  attributedModelId,
  cloneUsageBreakdown,
  createUsageBreakdown,
  normalizeLanguageModelUsage,
} from './agent/usage.js'
export type { UsageBreakdown, UsageDelta } from './agent/usage.js'
export { computeEditDiff } from './agent/diff.js'
export type { EditDiffHunk, EditDiffPayload } from './agent/diff.js'
export { generateTaskSlug, makePlanFilePath } from './agent/session/plan-storage.js'
export {
  COMPRESSION_TRIGGER_RATIO,
  MIN_CONTEXT_WINDOW_OVERRIDE,
  estimateMessageTokenCount,
  estimateTextTokenCount,
  estimateTokenCount,
  getCompressionThreshold,
  getContextWindow,
  getContextWindowOverride,
  setContextWindowOverride,
} from './agent/context/context-window.js'
export {
  buildContextBreakdownInput,
  calibrateContextBreakdown,
  estimateContextBreakdown,
} from './agent/context/context-usage.js'
export type { ContextBreakdown } from './agent/context/context-usage.js'
export {
  buildSystemPrompt,
  buildSubAgentSystemPrompt,
  formatDeferredCapabilities,
  formatMcpCapabilities,
  formatSkillCapabilities,
} from './agent/system-prompt.js'
export { classifyApiError } from './agent/api-errors.js'
export { buildUserContent, extractFileReferences, ingestFile, classifyFile } from './agent/ingest/file-ingest.js'
export type { FileKind, IngestedPart } from './agent/ingest/file-ingest.js'
export { formatTranscription, isAudioFile, transcribeAudio } from './agent/ingest/audio-transcribe.js'
export type { TranscribeAudioResult } from './agent/ingest/audio-transcribe.js'
export { captionImage, pickVisionProvider, resetVisionModelProviders } from './agent/ingest/vision-fallback.js'
export type { VisionUsageEvent } from './agent/ingest/vision-fallback.js'
export {
  admitGoalInput,
  buildVerifierFailurePrompt,
  cancelGoal,
  clearPendingTransition,
  clearGoal,
  createGoal,
  createGoalRunCoordinator,
  pauseGoal,
  promoteNextGoalInput,
  remainingTokenBudget,
  recordVerificationFailure,
  resetVerificationFailures,
  resumeGoal,
  runGoalLoop,
  runVerifierLadder,
  updateGoalStatus,
} from './agent/goal/index.js'
export type {
  GoalAttempt,
  GoalInput,
  GoalInputKind,
  GoalRunSummary,
  GoalState,
  GoalStatus,
  GoalVerifier,
  GoalVerificationResult,
} from './agent/goal/index.js'

// Provider capabilities
export { capabilitiesOf, modelSupportsVision, providerOf } from './providers/capabilities.js'
export type { ProviderCapabilities } from './providers/capabilities.js'
export { getReasoningTierOptions, supportsReasoningTier } from './providers/thinking.js'

// Tools
export { toolRegistry, truncateToolResult } from './tools/index.js'
export { TOOL_SEARCH_TOOL_NAME } from './tools/tool-search.js'
export { resolveWebSearchProvider } from './tools/web-search.js'
export { getShellProvider } from './tools/shell-provider.js'
export { forceTerminateManagedShellsSync } from './tools/shell-session/shutdown-target-registry.js'
export type {
  EmergencyTerminationResult,
  FinalObservationLease,
  ProcessTerminationResult,
  ShellExecutionResult,
  ShellFailure,
  ShellFailureCode,
  ShellObservation,
  ShellSessionController,
  ShellSessionEvent,
  ShellSessionListener,
  ShellSessionSummary,
  ShellTerminationResult,
  TerminateAllResult,
  TerminationBudget,
  TerminationReason,
} from './tools/shell-session/types.js'

// Permissions
export { checkPermission, getPermissionLevel } from './permissions/index.js'
export { addSessionAllowRule, clearSessionRules, buildAllowRule } from './permissions/index.js'
export { extractCommandPrefix, extractCompoundRules, suggestRuleLabel } from './permissions/index.js'
export { loadPersistedRules } from './permissions/index.js'
export type { AllowRule } from './permissions/session-store.js'
export {
  MAX_EGRESS_APPROVAL_BYTES,
  canonicalizeToolInput,
  classifyToolCall,
  evaluateToolAuthority,
  verifyAuthorityApproval,
} from './permissions/authority.js'

// Cross-session lifecycle primitives. Stage 0 deliberately exports no transport or service.
export { createPeerInbox } from './peers/inbox.js'
export { DEFAULT_PEER_INBOX_LIMITS } from './peers/inbox-types.js'
export type * from './peers/inbox-types.js'
export * from './peers/index.js'

// Utils
export { XCODE_DIR, debugLog, errorMessage, setPluginDebugMirror, userXcodeDir } from './utils/index.js'
export { LruCache } from './utils/lru-cache.js'
export { knownMediaTypeFor } from './utils/media-type.js'
export { extractText } from './utils/message-helpers.js'
export { ensureProjectStorageDir } from './utils/project-storage.js'

// Knowledge
export { buildKnowledgeContext } from './knowledge/loader.js'
export { MemoryService } from './knowledge/memory/service.js'
export { MemoryIndex, normalizeMemoryText, tokenizeMemoryText } from './knowledge/memory/search-index.js'
export { MemoryStore, formatMemoryTopic, parseMemoryTopic, renderCoreProfile } from './knowledge/memory/store.js'
export { buildRecallQuery, MemoryRetriever } from './knowledge/memory/retriever.js'
export type {
  EvidenceKind,
  LateRecallSignals,
  MemoryChange,
  MemoryJob,
  MemoryOperation,
  MemoryRecallAttachment,
  MemoryRecallTombstone,
  MemoryRecallTrace,
  MemorySearchArgs,
  MemorySearchContext,
  MemorySearchResult,
  MemoryStatus,
  MemoryStatusReport,
  MemoryTopic,
  MemoryType,
  MemoryWriteNotice,
  RecallQuery,
  TopicMetadataPatch,
  TurnMemoryProjection,
} from './knowledge/memory/types.js'

// Sub-agents
export { createSubAgentRegistry, createBuiltInRegistry, SubAgentRegistry } from './agent/sub-agents/index.js'
export type { SubAgentDefinition, SubAgentEvent } from './agent/sub-agents/index.js'
// Managed browser — private MCP lifecycle (gracefulShutdown closes the browser).
export { shutdownBrowserMcp } from './agent/browser/registry.js'

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
export { HookRegistry, buildHookRegistry, emptyHookRegistry } from './hooks/registry.js'
export { executeHook } from './hooks/executor.js'
export type { ExecuteHookOptions } from './hooks/executor.js'
export { parseHookConfig, HookConfigParseError } from './hooks/config-schema.js'
export { buildVariableContext, expandVariables } from './hooks/variables.js'
export type {
  HookConfig,
  HookConfigEntry,
  HookDecision,
  HookEvent,
  HookEventName,
  RegisteredHook,
} from './hooks/types.js'

// Plugins — discovery, install, marketplace, registry.
export { loadAllPlugins, resolveContributions } from './plugins/loader.js'
export type { LoadResult as PluginLoadResult, ResolvedContributions } from './plugins/loader.js'
export { PluginRegistry } from './plugins/registry.js'
export type { PluginReloadSummary } from './plugins/registry.js'
export {
  buildPluginIntegration,
  debugLogIntegrationDiagnostics,
  getPluginMcpServersFromDisk,
} from './plugins/integration.js'
export { refreshPluginContributions } from './plugins/refresh.js'
export {
  installPlugin,
  uninstallPlugin,
  listInstalledPlugins,
  findInstalledPlugin,
  InstallError,
} from './plugins/installer.js'
export { buildConsentPreview, probePluginRoot } from './plugins/consent.js'
export type { ConsentPreview } from './plugins/consent.js'
export { setPluginUserConfig, getPluginUserConfigEnv } from './plugins/user-config.js'
export type { UserConfigValue } from './plugins/user-config.js'
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
export { EnableState, setPluginEnabled, clearPluginEntry } from './plugins/enable-state.js'
export type {
  LoadedPlugin,
  PluginManifest,
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
  wrapActivatedSkill,
  userSkillsDir,
} from './skills/registry.js'
export type { SkillDefinition, SkillEntry, SkillOrigin, SkillReloadSummary } from './skills/registry.js'
export { getScopedDisabledSkills, setSkillDisabled, skillSettingsPath } from './skills/settings.js'
export type { SkillSettingsScope } from './skills/settings.js'

// Session store (per-session jsonl transcript — used by /resume,
// /usage history, and the CLI startup --resume / --continue flags).
export {
  appendCheckpoint,
  appendGoalInput,
  appendGoalState,
  appendGoalVerification,
  appendHeader,
  appendInterrupted,
  appendUsage,
  clearPeerContext,
  appendMemoryRecall,
  appendMemoryRecallDelete,
  captureSessionForkSnapshot,
  flushPendingMessages,
  forkSession,
  getSessionFilePath,
  hydrateLoopState,
  listSessions,
  loadSession,
  markBoundaryAndReflush,
  pickLatestSession,
} from './agent/session/session-store.js'
export type { LoadedSession, SessionForkOrigin, SessionForkSnapshot } from './agent/session/session-store.js'

// Rewind snapshots — file-history backing for /rewind.
export { createCheckpoint, restoreCheckpoint, getDiffStatsForCheckpoint } from './agent/session/snapshot.js'
export type { CheckpointEntry, DiffStats } from './agent/session/snapshot.js'

// MCP — Model Context Protocol client support.
export { McpRegistry, emptyRegistry } from './mcp/registry.js'
export type {
  RegisteredServer,
  RestartSummary as McpRestartSummary,
  ConnectResult as McpConnectResult,
  OAuthProviderFactory,
} from './mcp/registry.js'
export { loadMcpServers, loadMcpConfigsFromDisk, loadMergedConfigsFromDisk } from './mcp/loader.js'
export type { LoadOptions as McpLoadOptions } from './mcp/loader.js'
export { McpPermissionStore, classifyDecision } from './mcp/permissions.js'
export { isProjectTrusted, trustProject, promptForTrust, buildServerPreview } from './mcp/trust.js'
export type { TrustChoice } from './mcp/trust.js'
export { McpTokenStorage, getTokenStorage } from './mcp/oauth/token-storage.js'
export { McpOAuthProvider, createOAuthProviderFactory } from './mcp/oauth/provider.js'
export { startCallbackServer } from './mcp/oauth/callback-server.js'
export type { McpServerConfig, McpServerStatus, McpToolEntry, McpResourceEntry, McpCallResult } from './mcp/types.js'
export { isStdioConfig, isHttpConfig } from './mcp/types.js'
export { buildCallableName, MCP_MAX_NAME_LEN } from './mcp/name-mangling.js'
export { expandEnvDeep, expandEnvString, EnvExpansionError } from './mcp/expand-env.js'
export { parseServersBlock, parseServerConfig, mcpServersSchema } from './mcp/config-schema.js'
export { parseAdd, parseAddJson, parseRemove, tokenize } from './mcp/arg-parser.js'
export type { ConfigScope } from './mcp/arg-parser.js'
export {
  detectScope,
  getConfigPath as getMcpConfigPath,
  readServerConfig,
  removeServerFromConfig,
  serverExists,
  writeServerToConfig,
} from './mcp/config-writer.js'
