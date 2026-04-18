// @x-code-cli/core — Public API exports

// Types
export type {
  PermissionLevel,
  TokenUsage,
  DisplayMessage,
  DisplayToolCall,
  AgentCallbacks,
  AgentOptions,
  AppConfig,
  KnowledgeCategory,
  KnowledgeFact,
  SessionSummary,
  ModelMessage,
  LanguageModel,
} from './types/index.js'

export { MODEL_ALIASES, PROVIDER_DETECTION_ORDER, PROVIDER_KEY_URLS } from './types/index.js'

// Config
export {
  loadConfig,
  resolveModelId,
  getAvailableProviders,
  getEnvVarName,
  CONFIG_DIR,
  CONFIG_FILE,
} from './config/index.js'

// Provider Registry
export { createModelRegistry } from './providers/registry.js'

// Agent
export { agentLoop, saveSession, compressMessages } from './agent/loop.js'
export type { LoopState } from './agent/loop.js'
export { buildSystemPrompt } from './agent/system-prompt.js'

// Tools
export { toolRegistry, truncateToolResult } from './tools/index.js'
export { getShellConfig } from './tools/shell-utils.js'

// Permissions
export { checkPermission, getPermissionLevel } from './permissions/index.js'

// Utils
export { GLOBAL_XCODE_DIR, XCODE_DIR } from './utils.js'

// Knowledge
export { buildKnowledgeContext } from './knowledge/loader.js'
export { getAutoMemory, initMemories } from './knowledge/auto-memory.js'
export { loadLatestSession, saveSessionSummary, formatSessionForPrompt } from './knowledge/session.js'
export { initProject } from './knowledge/init.js'
