import { createHash, timingSafeEqual } from 'node:crypto'
import { realpathSync } from 'node:fs'
import path from 'node:path'

import { splitShellCommands } from '../tools/shell-utils.js'
import type {
  AuthorityApproval,
  AuthorityApprovalPreview,
  AuthorityDecision,
  ClassifiedToolCall,
  ExecutionAuthority,
  ToolCapability,
} from '../types/index.js'

export const MAX_EGRESS_APPROVAL_BYTES = 131_072

const NETWORK_COMMAND_RE =
  /(?:^|[^A-Za-z0-9_./-])(?:curl|wget|fetch|http|https|ftp|scp|sftp|ssh|nc|ncat|netcat|telnet|dig|nslookup|ping|npm\s+(?:publish|login)|pnpm\s+publish|git\s+(?:push|fetch|pull|clone)|docker\s+(?:push|pull|login))\b/i
const SHELL_RUNTIME_KEYWORD_RE = /\b(?:source|eval|xargs)\b|(?:^|\s)@[^\s]+|\bstdin\b/i
const SHELL_EXEC_WRAPPER_RE =
  /(?:^|[;&|]\s*)(?:command\s+|exec\s+|builtin\s+|nohup\s+|nice(?:\s+-\S+)*\s+|time\s+|sudo\s+|doas\s+)?(?:sh|bash|zsh|fish|dash|cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh|node|python\d*|perl|ruby)\b/i
const SHELL_FIND_EXEC_RE = /\bfind\b[^;&|]*(?:-exec(?:dir)?|-ok(?:dir)?|-fls|-fprint0?|-fprintf)\b/i
const SHELL_FIND_DELETE_RE = /\bfind\b[^;&|]*-delete\b/i
const AUDITED_DIRECT_MUTATION_RE = /^\s*(?:rm|rmdir|mkdir|touch|cp|mv|chmod|chown|ln)\b/i
const AUDITED_PEER_READ_ONLY_COMMAND_RE = /^\s*(?:pwd|ls|cat|head|tail|wc|grep)(?:\s|$)/

function containsRuntimeShellSyntax(command: string): boolean {
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false
  for (const char of command) {
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\' && !inSingleQuote) {
      escaped = true
      continue
    }
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      continue
    }
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }
    if (inSingleQuote) continue
    if (char === '$' || char === '`') return true
    if (inDoubleQuote) continue
    if ('<>|&{}()*?['.includes(char) || char === '\r' || char === '\n') return true
  }
  return escaped || inSingleQuote || inDoubleQuote || SHELL_RUNTIME_KEYWORD_RE.test(command)
}

function envRunsCommand(part: string): boolean {
  const tokens = part.trim().split(/\s+/)
  if (tokens[0]?.toLowerCase() !== 'env') return false
  for (const token of tokens.slice(1)) {
    if (token.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue
    return true
  }
  return false
}

function isAuditedPeerReadOnlyShell(parts: readonly string[]): boolean {
  return parts.length === 1 && AUDITED_PEER_READ_ONLY_COMMAND_RE.test(parts[0]!)
}

function isAuditedPeerMutationShell(parts: readonly string[], command: string): boolean {
  if (SHELL_FIND_DELETE_RE.test(command) && !SHELL_FIND_EXEC_RE.test(command)) return true
  return parts.length > 0 && parts.every((part) => AUDITED_DIRECT_MUTATION_RE.test(part))
}

function stableCanonicalJson(value: unknown): string {
  const seen = new Set<object>()
  const encode = (item: unknown): unknown => {
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return item
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error('non-finite number')
      return item
    }
    if (typeof item === 'bigint' || typeof item === 'symbol' || typeof item === 'function' || item === undefined) {
      throw new Error('unsupported value')
    }
    if (Array.isArray(item)) return item.map(encode)
    if (typeof item !== 'object') throw new Error('unsupported value')
    if (seen.has(item)) throw new Error('cyclic value')
    seen.add(item)
    const object = item as Record<string, unknown>
    const encoded: Record<string, unknown> = {}
    for (const key of Object.keys(object).sort()) encoded[key] = encode(object[key])
    seen.delete(item)
    return encoded
  }
  return JSON.stringify(encode(value))
}

export function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function authoritySnapshotHash(authority: ExecutionAuthority): string {
  return sha256Text(stableCanonicalJson(authority))
}

const SENSITIVE_PATH_SEGMENT_RE =
  /(?:^|[/\\])(?:\.env(?:\.[^/\\]+)?|\.ssh|\.aws|\.config[/\\](?:gh|gcloud)|\.npmrc|\.pypirc|\.netrc|\.git-credentials|credentials?|secrets?|memory)(?:$|[/\\])/i

function resolveExistingPath(pathValue: string): string {
  let candidate = pathValue
  const suffix: string[] = []
  while (true) {
    try {
      return path.join(realpathSync.native(candidate), ...suffix.reverse())
    } catch {
      const parent = path.dirname(candidate)
      if (parent === candidate) return pathValue
      suffix.push(path.basename(candidate))
      candidate = parent
    }
  }
}

function isSensitivePath(pathValue: string, cwd: string): boolean {
  const absolute = path.resolve(cwd, pathValue)
  const resolved = resolveExistingPath(absolute)
  const relative = path.relative(resolveExistingPath(path.resolve(cwd)), resolved)
  const outside = relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)
  return outside || SENSITIVE_PATH_SEGMENT_RE.test(absolute) || SENSITIVE_PATH_SEGMENT_RE.test(resolved)
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
}

function pathInputs(toolName: string, input: Record<string, unknown>, cwd: string): string[] {
  const keys: Record<string, readonly string[]> = {
    readFile: ['filePath'],
    writeFile: ['filePath'],
    edit: ['filePath'],
    glob: ['cwd'],
    grep: ['path'],
    listDir: ['dirPath'],
  }
  return (keys[toolName] ?? [])
    .map((key) => input[key])
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map((value) => path.resolve(cwd, value))
}

function classifyBuiltin(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): { capabilities: ToolCapability[]; destination?: string; paths?: string[]; runtimeOpaque?: boolean } {
  const paths = pathInputs(toolName, input, cwd)
  if (['readFile', 'glob', 'grep', 'listDir'].includes(toolName)) {
    const capability = paths.some((candidate) => isSensitivePath(candidate, cwd)) ? 'sensitive-read' : 'content-read'
    return { capabilities: [capability], paths }
  }
  if (toolName === 'shellOutput') {
    const mutatesTerminal =
      (input.chars !== undefined && input.chars !== '') || input.cols !== undefined || input.rows !== undefined
    return { capabilities: [mutatesTerminal ? 'local-mutation' : 'sensitive-read'] }
  }
  if (toolName === 'memorySearch') return { capabilities: ['sensitive-read'] }
  if (toolName === 'webSearch') return { capabilities: ['network-egress'], destination: 'web-search-provider' }
  if (toolName === 'webFetch') {
    const destination = typeof input.url === 'string' ? input.url : 'unknown-url'
    return { capabilities: ['network-egress'], destination }
  }
  if (toolName === 'sendMessage') {
    const fixedAddress = typeof input._receiverAddress === 'string' ? input._receiverAddress : undefined
    return {
      capabilities: ['peer-egress'],
      destination: fixedAddress ?? (typeof input.to === 'string' ? input.to : 'unknown-peer'),
      runtimeOpaque: !fixedAddress || typeof input._receiverInstanceId !== 'string',
    }
  }
  if (toolName === 'shell') {
    const command = typeof input.command === 'string' ? input.command : ''
    const parts = splitShellCommands(command)
    const readOnly = isAuditedPeerReadOnlyShell(parts)
    const network = NETWORK_COMMAND_RE.test(command)
    const auditedMutation = isAuditedPeerMutationShell(parts, command)
    const opaqueSyntax =
      !command.trim() ||
      (input.runInBackground !== undefined && input.runInBackground !== false) ||
      containsRuntimeShellSyntax(command) ||
      SHELL_EXEC_WRAPPER_RE.test(command) ||
      SHELL_FIND_EXEC_RE.test(command) ||
      parts.some(envRunsCommand) ||
      network ||
      (!readOnly && !network && !auditedMutation)
    const capabilities: ToolCapability[] = readOnly && !opaqueSyntax ? ['content-read'] : ['local-mutation']
    if (network) capabilities.push('network-egress')
    return {
      capabilities,
      destination: network ? 'runtime-selected-by-shell' : undefined,
      runtimeOpaque: opaqueSyntax,
    }
  }
  if (toolName === 'writeFile' || toolName === 'edit' || toolName === 'killShell') {
    return { capabilities: ['local-mutation'], paths }
  }
  if (
    toolName === 'enterPlanMode' ||
    toolName === 'exitPlanMode' ||
    toolName === 'updateGoal' ||
    toolName === 'createGoal'
  ) {
    return { capabilities: ['configuration-change'] }
  }
  if (toolName === 'task') {
    return { capabilities: ['sensitive-read', 'local-mutation'] }
  }
  if (toolName === 'browserVisualCheck') {
    return { capabilities: ['sensitive-read', 'local-mutation', 'network-egress'], destination: 'browser-target' }
  }
  if (toolName === 'readMcpResource') return { capabilities: ['opaque-mcp'] }
  if (toolName === 'activateSkill') return { capabilities: ['content-read'] }
  if (toolName === 'getGoal') return { capabilities: ['sensitive-read'] }
  if (['listAgents', 'listMcpResources'].includes(toolName)) {
    return { capabilities: ['session-metadata-read'] }
  }
  if (toolName === 'todoWrite') return { capabilities: ['local-mutation'] }
  if (['askUser', 'toolSearch'].includes(toolName)) return { capabilities: ['pure-compute'] }
  return { capabilities: ['unknown'] }
}

function payloadFor(
  toolName: string,
  input: Record<string, unknown>,
  capabilities: readonly ToolCapability[],
  cwd: string,
): { format: 'text' | 'canonical-json' | 'shell-command'; canonical: string } | undefined {
  if (toolName === 'shell') {
    return {
      format: 'canonical-json',
      canonical: stableCanonicalJson({ command: typeof input.command === 'string' ? input.command : '', cwd }),
    }
  }
  if (toolName === 'shellOutput' || toolName === 'killShell') {
    return {
      format: 'canonical-json',
      canonical: stableCanonicalJson({
        managerInstanceId: input._managerInstanceId,
        shellId: input.shellId,
        command: input._command,
        cwd: input._effectiveCwd,
        ...(toolName === 'shellOutput'
          ? {
              chars: input.chars ?? '',
              ...(input.cols !== undefined ? { cols: input.cols } : {}),
              ...(input.rows !== undefined ? { rows: input.rows } : {}),
            }
          : { terminationReason: 'kill-tool' }),
      }),
    }
  }
  if (!capabilities.some((capability) => ['network-egress', 'peer-egress', 'opaque-mcp'].includes(capability))) {
    return undefined
  }
  if (toolName === 'sendMessage') {
    return {
      format: 'canonical-json',
      canonical: stableCanonicalJson({
        to: input.to,
        ...(input._receiverInstanceId !== undefined ? { receiverInstanceId: input._receiverInstanceId } : {}),
        ...(input._receiverAddress !== undefined ? { receiverAddress: input._receiverAddress } : {}),
        message: input.message,
        ...(input.summary !== undefined ? { summary: input.summary } : {}),
        ...(input.messageId !== undefined ? { messageId: input.messageId } : {}),
      }),
    }
  }
  return { format: 'canonical-json', canonical: stableCanonicalJson(input) }
}

export function classifyToolCall(input: {
  toolName: string
  input: Record<string, unknown>
  authority: ExecutionAuthority
  cwd?: string
  mcpServerId?: string
  isMcpTool?: boolean
}): ClassifiedToolCall {
  const authority: ExecutionAuthority =
    input.authority.source === 'peer' && !input.authority.peerTainted
      ? { ...input.authority, peerTainted: true }
      : input.authority
  const cwd = input.cwd ?? process.cwd()
  const classified = input.isMcpTool
    ? { capabilities: ['opaque-mcp'] as ToolCapability[], destination: input.mcpServerId }
    : classifyBuiltin(input.toolName, input.input, cwd)
  let complete = true
  let reason: string | undefined
  let outboundPayload: AuthorityApprovalPreview['outboundPayload']
  try {
    const payload = payloadFor(input.toolName, input.input, classified.capabilities, cwd)
    if (payload) {
      const byteLength = Buffer.byteLength(payload.canonical, 'utf8')
      outboundPayload = {
        ...payload,
        byteLength,
        sha256: sha256Text(payload.canonical),
      }
      if (byteLength > MAX_EGRESS_APPROVAL_BYTES) {
        complete = false
        reason = `Canonical outbound payload exceeds ${MAX_EGRESS_APPROVAL_BYTES} bytes`
      }
    }
  } catch {
    complete = false
    reason = 'Tool input cannot be represented as stable canonical JSON'
  }
  if (classified.runtimeOpaque) {
    complete = false
    reason = classified.capabilities.includes('network-egress')
      ? 'Network shell is disabled for peer-influenced context; use an audited web tool with an explicit payload'
      : 'Outbound payload depends on runtime-only indirection'
  }
  const capabilities = classified.capabilities
  const authorityHash = authoritySnapshotHash(authority)
  let canonicalCallSha256 = sha256Text('unapprovable')
  try {
    canonicalCallSha256 = sha256Text(
      stableCanonicalJson({
        toolName: input.toolName,
        ...(input.mcpServerId ? { serverId: input.mcpServerId } : {}),
        ...(classified.destination ? { destination: classified.destination } : {}),
        input: input.toolName === 'shell' ? { ...input.input, cwd } : input.input,
        authorityHash,
      }),
    )
  } catch {
    complete = false
    reason = 'Tool input cannot be represented as stable canonical JSON'
  }
  const approvable =
    complete &&
    !capabilities.includes('unknown') &&
    !capabilities.includes('configuration-change') &&
    input.toolName !== 'memorySearch' &&
    input.toolName !== 'task' &&
    input.toolName !== 'updateGoal'
  return {
    capabilities,
    approvalPreview: {
      toolName: input.toolName,
      ...(input.mcpServerId ? { serverId: input.mcpServerId } : {}),
      ...(classified.paths?.length ? { paths: classified.paths } : {}),
      ...(classified.destination ? { destination: classified.destination } : {}),
      summary: `${capabilities.join(', ')} request by peer-influenced context`,
      ...(outboundPayload ? { outboundPayload } : {}),
      complete,
      approvable,
      ...(reason ? { reason } : {}),
      authorityHash,
      canonicalCallSha256,
    },
  }
}

export function evaluateToolAuthority(input: {
  toolName: string
  input: Record<string, unknown>
  authority: ExecutionAuthority
  trustMode?: boolean
  cwd?: string
  mcpServerId?: string
  isMcpTool?: boolean
}): AuthorityDecision {
  if (!input.authority.peerTainted && input.authority.source !== 'peer') {
    return { kind: 'allow', basis: 'user-authority' }
  }
  // A peer message cannot grant authority, but it must not revoke authority
  // the local user explicitly granted when starting this receiving session.
  if (input.trustMode) return { kind: 'allow', basis: 'user-authority' }
  const classified = classifyToolCall(input)
  const capabilities = classified.capabilities
  if (capabilities.every((capability) => capability === 'pure-compute')) {
    return { kind: 'allow', basis: 'pure-compute' }
  }
  if (capabilities.every((capability) => capability === 'session-metadata-read')) {
    return { kind: 'allow', basis: 'session-metadata' }
  }
  if (capabilities.includes('unknown')) {
    return { kind: 'deny', reason: `Tool ${input.toolName} has no audited authority classification` }
  }
  if (capabilities.includes('configuration-change')) {
    return { kind: 'deny', reason: 'Peer-influenced context cannot change session configuration' }
  }
  if (input.toolName === 'memorySearch') {
    return { kind: 'deny', reason: 'Long-term memory search is disabled for peer-influenced context' }
  }
  if (input.toolName === 'task' || input.toolName === 'updateGoal') {
    return { kind: 'deny', reason: `${input.toolName} is disabled for peer-influenced context` }
  }
  if (!classified.approvalPreview.approvable || !classified.approvalPreview.complete) {
    return {
      kind: 'deny',
      reason: classified.approvalPreview.reason ?? 'The complete canonical payload cannot be safely displayed',
    }
  }
  return {
    kind: 'ask',
    reason: 'Peer-influenced tool calls require a local allow-once decision',
    preview: classified.approvalPreview,
  }
}

function equalHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

export function verifyAuthorityApproval(
  approval: AuthorityApproval,
  preview: AuthorityApprovalPreview,
  currentAuthority: ExecutionAuthority,
): boolean {
  if (approval.decision !== 'allow-once' || !preview.complete || !preview.approvable) {
    return false
  }
  if (!equalHex(approval.authorityHash, authoritySnapshotHash(currentAuthority))) return false
  if (!equalHex(approval.canonicalCallSha256, preview.canonicalCallSha256)) return false
  if (preview.outboundPayload) {
    return (
      typeof approval.canonicalPayloadSha256 === 'string' &&
      equalHex(approval.canonicalPayloadSha256, preview.outboundPayload.sha256)
    )
  }
  return approval.canonicalPayloadSha256 === undefined
}

export function canonicalizeToolInput(input: Record<string, unknown>): string {
  return stableCanonicalJson(input)
}
