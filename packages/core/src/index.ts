// @x-code/core — Public API exports

export const VERSION = '0.1.0'

// Types
export type {
  PermissionLevel,
  TokenUsage,
  DisplayMessage,
  DisplayToolCall,
  AgentCallbacks,
  AgentOptions,
  AppConfig,
  ProviderConfig,
  KnowledgeFact,
  SessionSummary,
  RuleFrontmatter,
  RuleFile,
  ModelMessage,
  LanguageModel,
} from './types/index.js'

export { MODEL_ALIASES, PROVIDER_DETECTION_ORDER, PROVIDER_KEY_URLS } from './types/index.js'

// Config
export { loadConfig, saveConfig, resolveModelId, getAvailableProviders, CONFIG_DIR, CONFIG_FILE } from './config/index.js'

// Provider Registry
export { createModelRegistry } from './providers/registry.js'

// Agent
export { agentLoop, saveSession, compressMessages } from './agent/loop.js'
export { buildSystemPrompt } from './agent/system-prompt.js'
export { estimateTokens } from './agent/messages.js'
export { estimateCost } from './agent/pricing.js'

// Tools
export { toolRegistry, truncateToolResult } from './tools/index.js'
export { getShellConfig } from './tools/shell-utils.js'

// Permissions
export { checkPermission, getPermissionLevel } from './permissions/index.js'

// Knowledge
export { buildKnowledgeContext } from './knowledge/loader.js'
export { getAutoMemory, initMemories } from './knowledge/auto-memory.js'
export { loadLatestSession, saveSessionSummary, formatSessionForPrompt } from './knowledge/session.js'
export { scanProject } from './knowledge/hooks.js'
export { initProject } from './knowledge/init.js'
