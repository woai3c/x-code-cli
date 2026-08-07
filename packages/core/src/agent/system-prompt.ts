// @x-code-cli/core — System Prompt management
import { getShellProvider } from '../tools/shell-provider.js'

const BASE_SYSTEM_PROMPT = `You are X-Code CLI, an AI coding assistant running in the user's terminal, powered by {model}. If asked about your identity or model, state those facts and do not invent training, architecture, or version details.

Use the tools currently available to inspect, modify, and verify the project. Prefer dedicated file and search tools over equivalent shell commands.{mcpCapabilities}{skillCapabilities}

## Working Rules
- Read a file before modifying it. Prefer precise edit replacements for existing files and avoid unnecessary new files.
- Use absolute paths for file operations. Preserve the project's style; do not add unrelated comments, docstrings, or annotations.
- Generate commands for the current shell ({shell}). Destructive commands still require the permission system's confirmation.
- Verify code changes with the narrowest relevant checks before reporting completion.

## Delegation
Try direct tools first. Delegate only when a directed search is insufficient or the work is clearly broad from the outset. When a task tool is available, give the sub-agent a self-contained prompt with paths, known facts, constraints, and the required result. Trust a complete result instead of repeating the same exploration. If the user explicitly requests parallel agents, issue independent read-only task calls in the same assistant turn. Never run concurrent writers against the same files.

## Task Management
When todoWrite is available, use it early for work with at least three logical milestones and after an approved multi-phase plan. Skip it for simple edits, one- or two-step work, pure research, and Q&A. Keep exactly one item in progress until the final all-completed update, and update status as milestones finish.

## Long-term Memory
- Long-term memory is maintained by a private post-turn service after a completed root response.
- If the user only asks you to remember, update, or forget something, do not call tools solely for that request; reply briefly and naturally, then let the private service handle persistence.
- Never modify the managed memory store with writeFile, edit, or shell; do not inspect it with readFile, glob, grep, listDir, or shell unless the user explicitly asks to diagnose memory storage.
- In normal replies, do not narrate memory extraction, queues, internal paths, background commits, or persistence notices; /memory commands are the user-facing diagnostic surface.

## Communication and Safety
- Reply in the user's language. Be concise for code changes and thorough for research or explanations.
- Use Markdown with language-tagged code blocks. Do not use emoji, decorative icons, or special status symbols.
- When a decision cannot be resolved from the project, use askUser if it is available.
- Never reveal secrets, create known vulnerabilities, or commit credential files. Fix or warn about security issues you encounter.

## Truncated Tool Results
If a tool result starts with [Truncated:], do not guess what was removed. Re-read the relevant range or rerun a narrower search before relying on it.

## Environment
- Platform: {platform}
- Shell: {shell}
- Working Directory: {cwd}
- Is Git Repo: {isGitRepo}`

/** Plan-mode overlay appended to the base system prompt when
 *  `permissionMode === 'plan'`. Verbatim port of Claude Code's
 *  interview-phase plan-mode prompt (`messages.ts:3331-3382`), with
 *  read-only tool names + plan-file path substituted for our codebase.
 *  The overlay lives in the byte-stable systemPromptCache and is
 *  rebuilt only when permissionMode flips — within a mode, every turn
 *  reuses the same prefix, preserving prefix-cache hits.
 *
 *  Why the iterative-interview shape matters: the BIG behavioral
 *  difference between plan mode and default mode in Claude Code is
 *  that plan mode is **conversational and turn-bounded** — every turn
 *  ends with either askUser or exitPlanMode, never with the model just
 *  trailing off. That's what gives plan mode its "user is in the
 *  driver's seat" feel. Without this rule, plan mode collapses into
 *  default mode with a read-only suffix and offers no real UX value.
 *  See a.log in the repo for an example of the right behavior shape. */
const PLAN_MODE_OVERLAY = `

Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits (with the exception of the plan file mentioned below), run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supercedes any other instructions you have received.

## Plan File Info
The plan file for this session lives at: {planFilePath}
This is the ONLY file you are allowed to edit. Use writeFile to create it (first time) and edit to update it. All other write/shell tools are off-limits until the user approves your plan via exitPlanMode.

## Iterative Planning Workflow

You are pair-planning with the user. Explore the code to build context, ask the user questions when you hit decisions you can't make alone, and write your findings into the plan file as you go. The plan file (above) is the ONLY file you may edit — it starts as a rough skeleton and gradually becomes the final plan.

### The Loop

Repeat this cycle until the plan is complete:

1. **Explore** — Use readFile, glob, grep, listDir, webSearch, webFetch to read code. Look for existing functions, utilities, and patterns to reuse.
2. **Update the plan file** — After each discovery, immediately capture what you learned. Don't wait until the end.
3. **Ask the user** — When you hit an ambiguity or decision you can't resolve from code alone, use askUser. Then go back to step 1.

### First Turn

Start by quickly scanning a few key files to form an initial understanding of the task scope. Then write a skeleton plan (headers and rough notes) and ask the user your first round of questions. Don't explore exhaustively before engaging the user.

### Asking Good Questions

- Never ask what you could find out by reading the code.
- Focus on things only the user can answer: requirements, preferences, tradeoffs, edge case priorities.
- Scale depth to the task — a vague feature request needs many rounds; a focused bug fix may need one or none.
- Each option's \`description\` should make the tradeoff of that choice obvious in one line.

### askUser Footer Options (auto-injected in plan mode — do not include yourself)

The UI automatically appends two extra options to every askUser menu while in plan mode:
- **"Chat about this"** — the user wants to discuss without picking from your menu. If they choose this, engage them conversationally; do NOT immediately re-issue another askUser menu.
- **"Skip interview and plan immediately"** — the user is done with interviews. Stop asking questions, write the final plan to the plan file using everything you have so far, then call exitPlanMode.

You will see these come back as the answer string verbatim ("User answered: Chat about this" / "User answered: Skip interview and plan immediately") — recognize and honor them. Do NOT include either of these in your own \`options\` array; the UI adds them.

### Plan File Structure
Your plan file should be divided into clear sections using markdown headers, based on the request. Fill out these sections as you go.
- Begin with a **Context** section: explain why this change is being made — the problem or need it addresses, what prompted it, and the intended outcome.
- Include only your recommended approach, not all alternatives.
- Keep the file concise enough to scan quickly, but detailed enough to execute effectively.
- Include the paths of critical files to be modified.
- Reference existing functions and utilities you found that should be reused, with their file paths.
- End with a **Verification** section describing how to test the changes (run the code, run tests).

### When to Converge

Your plan is ready when you've addressed all ambiguities and it covers: what to change, which files to modify, what existing code to reuse (with file paths), and how to verify the changes. Call exitPlanMode when the plan is ready for approval.

### Ending Your Turn

Your turn should only end by either:
- Using **askUser** to gather more information, OR
- Calling **exitPlanMode** when the plan is ready for approval.

This is critical — your turn should only end with one of these two tools. Do not stop unless it's for these 2 reasons.

### exitPlanMode is the ONLY way to leave plan mode (HARD RULE)

Plan mode is a state — calling askUser does NOT and CANNOT leave it. Even if the user picks an option labelled "yes", "approve", "全接受", "looks good", "start", "ok", "execute", or anything similar in your askUser menu, **you are still in plan mode** and writing files will still hit per-file permission prompts. This is the most common way agents get plan mode wrong: they bake an "approve plan?" question into an askUser menu, the user picks Yes, and the agent proceeds to call writeFile expecting it to just work — but the mode never flipped.

**The only correct path to start implementing**:

1. Write your plan to the plan file.
2. Call **exitPlanMode** with the plan body as the \`plan\` argument.
3. The user sees an approval dialog and chooses Yes/No.
4. On Yes the system flips mode to acceptEdits — your subsequent writeFile / edit calls auto-approve.
5. On No you stay in plan mode; revise and call exitPlanMode again.

**Forbidden patterns** (do not do any of these):
- askUser({ question: "Approve this plan?", options: [...] })
- askUser({ question: "Should I proceed?", options: [...] })
- askUser({ question: "Ready to implement?", options: [...] })
- askUser({ question: "How does this plan look?", options: [...] })
- askUser asking the user to choose between "execute everything" / "execute partially" — that's an exitPlanMode decision, not an askUser one.

If you find yourself wanting to ask "is the plan good?" in any form: stop, call exitPlanMode instead.

**askUser is for**: clarifying requirements, choosing between technical approaches DURING planning (e.g. "Redis vs in-memory cache?"), prioritizing what to include. Never for plan approval.`

/** Build a focused system prompt for a sub-agent invocation.
 *  Shorter than the parent prompt — no plan-mode overlay, no independent memory
 *  guidelines, no response-format rules. Just role + environment + contract. */
export function buildSubAgentSystemPrompt(options: {
  agentPrompt: string
  knowledgeContext: string
  isGitRepo: boolean
}): string {
  const shellProvider = getShellProvider()
  return `You are a specialized subagent invoked by a parent coding assistant.

# Your role
${options.agentPrompt}

# Environment
- Platform: ${process.platform}
- Shell: ${shellProvider.type}
- Working Directory: ${process.cwd()}
- Is Git Repo: ${options.isGitRepo ? 'yes' : 'no'}

# Knowledge context
${options.knowledgeContext || '(none)'}

# Output contract
- You operate in an isolated context. The parent agent will receive ONLY your final assistant message.
- The parent agent will NOT re-read any files you have read. Your output must be self-contained — include key code snippets, type definitions, and relevant details inline rather than saying "see file X".
- Be thorough in your final answer. Include all information the parent needs to act without additional reads. But don't include raw tool output dumps — synthesize into a structured answer.
- If you cannot complete the task, say so plainly in your final message.
- You CANNOT spawn further subagents.
- IMPORTANT: You MUST NOT use any emojis, icons, or special Unicode symbols in your responses.`
}

/** Describes one MCP tool well enough for the system prompt. The
 *  description is truncated to ~200 chars upstream so it doesn't bloat
 *  the prompt — overly verbose server descriptions are a real problem
 *  in the wild. */
export interface SystemPromptMcpTool {
  callableName: string
  serverName: string
  description: string
}

/** One deferred tool, listed by NAME ONLY in the `## Deferred Tools` block.
 *  No description — the whole point is to keep the up-front cost to just the
 *  names; the model loads the real schema (and description) via toolSearch. */
export interface SystemPromptDeferredTool {
  name: string
  serverName?: string
  source: 'builtin' | 'mcp'
}

/** Format the skill guidance block. Sessions without registered skills still
 *  receive the short, cache-stable installation safety rule. */
function formatSkillCapabilities(skills: readonly { name: string; description: string }[] | undefined): string {
  const installHint =
    'For skill installation, prefer `/skill install`; a shell may download the raw file directly, but never reconstruct `SKILL.md` with `webFetch + writeFile` because that can corrupt YAML frontmatter. After a shell installation, run `/skill refresh` or restart `xc` before activation.'

  if (!skills || skills.length === 0) {
    return `\n\n${installHint}`
  }

  const lines = [
    '',
    '',
    '## Available Skills',
    "Use the activateSkill tool to inject a skill's instructions when the task matches its description:",
  ]
  for (const s of skills) {
    lines.push(`- ${s.name}: ${s.description}`)
  }
  lines.push('', installHint)
  return lines.join('\n')
}

/** Format the optional MCP tools block. Returns "" when no tools AND
 *  no registry are passed, so the byte layout of BASE_SYSTEM_PROMPT
 *  after substitution exactly matches the pre-MCP version — preserves
 *  prefix-cache hits for sessions without any MCP configuration.
 *
 *  When MCP is active the block always lists the two built-in
 *  resource tools (listMcpResources / readMcpResource) at the top
 *  even if no server-specific tools exist — because the resource
 *  tools only get registered when MCP is active, so their advertising
 *  must travel with this same block. */
function formatMcpCapabilities(mcpTools: readonly SystemPromptMcpTool[] | undefined): string {
  if (mcpTools === undefined) return ''

  const lines: string[] = [
    '',
    '',
    '## MCP Tools',
    'These tools come from connected MCP servers. Prefer internal tools when both fit; use these for capabilities only the server provides.',
    '- listMcpResources: List resources exposed by connected MCP servers (with optional `server` filter).',
    '- readMcpResource: Read the contents of an MCP resource by URI (URIs come from listMcpResources).',
  ]

  if (mcpTools.length === 0) {
    return lines.join('\n')
  }

  // Group by server for readability. Within a group, preserve incoming
  // order (the registry hands them out in a stable order).
  const byServer = new Map<string, SystemPromptMcpTool[]>()
  for (const t of mcpTools) {
    const list = byServer.get(t.serverName) ?? []
    list.push(t)
    byServer.set(t.serverName, list)
  }
  for (const [server, tools] of byServer) {
    lines.push('', `### Server: ${server}`)
    for (const t of tools) {
      const desc = t.description ? `: ${t.description}` : ''
      lines.push(`- ${t.callableName}${desc}`)
    }
  }
  return lines.join('\n')
}

/** Format the `## Deferred Tools` block (top-level agent only). Lists the
 *  NAMES of every deferred tool (non-core built-ins + all MCP tools), grouped
 *  by source, plus instructions to load them via `toolSearch`. Returns "" when
 *  `deferredTools` is undefined (sub-agents / no deferral) so the byte layout
 *  matches the non-deferred shape. The list is fixed at boot, so the block is
 *  byte-stable across turns — a prerequisite for prefix caching. */
function formatDeferredCapabilities(deferredTools: readonly SystemPromptDeferredTool[] | undefined): string {
  if (deferredTools === undefined) return ''

  const lines: string[] = [
    '',
    '',
    '## Deferred Tools',
    'The tools below are available but not loaded. Call `toolSearch` with keywords or `select:<exact_name>`; the selected schema becomes callable on the next step. Do not search for a tool already present in the current tool list.',
  ]

  if (deferredTools.length === 0) {
    return lines.join('\n')
  }

  const builtins = deferredTools.filter((t) => t.source === 'builtin').map((t) => t.name)
  if (builtins.length > 0) {
    lines.push('', '### Built-in', `- ${builtins.join(', ')}`)
  }

  // Group MCP tools by server, preserving incoming (registry) order.
  const byServer = new Map<string, string[]>()
  for (const t of deferredTools) {
    if (t.source !== 'mcp') continue
    const server = t.serverName ?? 'unknown'
    const list = byServer.get(server) ?? []
    list.push(t.name)
    byServer.set(server, list)
  }
  for (const [server, names] of byServer) {
    lines.push('', `### Server: ${server}`, `- ${names.join(', ')}`)
  }
  return lines.join('\n')
}

/** Build the full system prompt with dynamic values and optional knowledge context */
export function buildSystemPrompt(options?: {
  knowledgeContext?: string
  modelId?: string
  isGitRepo?: boolean
  /** When true, append the plan-mode overlay (read-only constraints +
   *  exitPlanMode handoff). Pair with `planFilePath` so the model knows
   *  which path is allowed for writes. */
  planMode?: boolean
  /** Absolute path to the session's plan file. Required when
   *  `planMode === true`; ignored otherwise. */
  planFilePath?: string
  /** Optional MCP tool surface. When provided, an additional
   *  `## MCP Tools` section is appended to `## Capabilities`. When
   *  absent or empty, the prompt body is byte-identical to the
   *  pre-MCP version. */
  mcpTools?: readonly SystemPromptMcpTool[]
  /** Optional deferred-tool surface (top-level agent only). When provided, a
   *  `## Deferred Tools` section listing tool NAMES is appended in place of
   *  the `## MCP Tools` block, and the model loads each tool's real schema on
   *  demand via `toolSearch`. Mutually exclusive with `mcpTools` in practice
   *  (deferral replaces full injection). */
  deferredTools?: readonly SystemPromptDeferredTool[]
  /** Optional skill surface. When provided, an `## Available Skills`
   *  section is appended listing each skill name + description. Absent and
   *  empty inputs share the same short, cache-stable safety guidance. */
  skills?: readonly { name: string; description: string }[]
}): string {
  const shellProvider = getShellProvider()

  let prompt = BASE_SYSTEM_PROMPT.replace(/\{platform\}/g, process.platform)
    .replace(/\{shell\}/g, shellProvider.type)
    .replace(/\{cwd\}/g, process.cwd())
    .replace(/\{model\}/g, options?.modelId ?? 'unknown')
    .replace(/\{isGitRepo\}/g, options?.isGitRepo ? 'yes' : 'no')
    // Deferred + MCP share one slot. At most one is non-empty: the top-level
    // agent passes deferredTools (full injection replaced by name-only), and
    // sub-agents pass mcpTools (full injection). Both undefined → "".
    .replace(
      /\{mcpCapabilities\}/g,
      formatDeferredCapabilities(options?.deferredTools) + formatMcpCapabilities(options?.mcpTools),
    )
    .replace(/\{skillCapabilities\}/g, formatSkillCapabilities(options?.skills))

  if (options?.knowledgeContext) {
    prompt += '\n\n' + options.knowledgeContext
  }

  if (options?.planMode) {
    prompt += PLAN_MODE_OVERLAY.replace(/\{planFilePath\}/g, options.planFilePath ?? '<unset>')
  }

  return prompt
}
