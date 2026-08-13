// ChatInput public + internal data types.
import type { AuthorityApprovalPreview, DisplayMessage, TodoItem } from '@x-code-cli/core'

import type { TurnOwner } from '../agent/turn-coordinator.js'
import type { ActiveToolCall } from '../agent/use-agent.js'

export interface ChatInputProps {
  messages: readonly DisplayMessage[]
  initialContentRows?: number
  onSubmit: (text: string) => void
  onInterrupt: () => void
  onEscapeCancel?: () => void
  isLoading?: boolean
  notice?: string | null
  peerInfluenced?: boolean
  trustMode?: boolean
  pendingPeerCount?: number
  disabled?: boolean
  hidden?: boolean
  spinner?: SpinnerState | null
  activeTurnOwner?: TurnOwner | null
  hasStableForkBoundary?: boolean
  activeToolCalls?: readonly ActiveToolCall[]
  todos?: readonly TodoItem[]
  queuedMessages?: readonly { id: string; text: string }[]
  onPopQueued?: (id: string) => void
  draftRestore?: { text: string; nonce: number } | null
  errorMessage?: string | null
  permission?: PermissionRequest | null
  authorityRequest?: AuthorityRequest | null
  selectRequest?: SelectRequest | null
  commands?: readonly SlashCommand[]
  permissionMode?: 'default' | 'acceptEdits' | 'plan'
  contextUsage?: { used: number; window: number } | null
  modelLabel?: string
}

/** One row in the slash-completion menu. Top-level command rows and
 *  subcommand rows are both rendered through this shape — display columns
 *  use `name`/`description`, but accept paths use `applyText` so a
 *  subcommand row (`{ name: 'auth', applyText: '/mcp auth' }`) replaces the
 *  whole input correctly. */
export interface MenuItem {
  name: string
  description: string
  applyText: string
  /** Dim suffix shown after `name` in the menu (e.g. `[on|off]` for
   *  `/thinking`). Only populated for stage-1 rows; subcommand rows
   *  don't carry one because the description column already explains
   *  the shape. */
  argumentHint?: string
}

export interface SlashCommand {
  name: string
  description: string
  /** Grey placeholder shown after the command name in the slash menu.
   *  Example: `argumentHint: '[on|off]'` makes the menu line read
   *  `/thinking [on|off]  Toggle extended thinking ...`. Used by
   *  commands that take args but have no fixed enumerable subcommands
   *  (e.g. `/model <model-id>`, `/review [PR]`). */
  argumentHint?: string
  /** Fixed enumerable subcommands. When present, typing `/cmd ` (with
   *  trailing space) or `/cmd <prefix>` shows a second-stage fuzzy
   *  menu over `subcommands` — same UI as the top-level command menu.
   *  Reserved for commands with many discrete second tokens that are
   *  easy to forget (`/mcp` has 8). */
  subcommands?: ReadonlyArray<{ name: string; description: string }>
}

interface SpinnerState {
  label: string
  mode: 'requesting' | 'responding' | 'thinking' | 'tool-use'
}

interface PermissionRequest {
  toolName: string
  input: Record<string, unknown>
  onResolve: (decision: 'yes' | 'always' | 'no') => void
  /** Set by use-agent when the tool resolves to an MCP registry entry.
   *  Drives the MCP-flavoured title / preview / always-allow label in
   *  the dialog. Absent for built-in tools (shell/edit/writeFile/…). */
  mcp?: { serverName: string; rawName: string }
}

interface AuthorityRequest {
  toolName: string
  preview: AuthorityApprovalPreview
  onResolve: (allow: boolean, viewedComplete: boolean) => void
}

interface SelectRequest {
  question: string
  /** `freeform: true` marks the auto-appended "Other" row that opens an
   *  inline text input instead of resolving with the literal label.
   *  Mirrors Claude Code's `__other__` sentinel — kept as a flag here so
   *  the resolver returns the typed text directly without a sentinel
   *  round-trip.
   *
   *  `preview` carries pre-rendered ANSI lines that the dialog draws
   *  below the option list whenever this option is the focused one.
   *  Used by the `/theme` picker to show a live color sample of each
   *  theme as the user arrows through. Each row should already be a
   *  complete ANSI-styled string — the dialog wraps it in a `RawAnsi`-
   *  like cell row without further processing. */
  options: { label: string; description: string; freeform?: boolean; preview?: string[] }[]
  onResolve: (answer: string) => void
  /** True for user-initiated pickers (slash commands like `/theme`,
   *  `/model`) — Esc dismisses the dialog with an empty answer. AI-
   *  initiated dialogs (askUser tool, plan approval) leave this falsy:
   *  Esc is swallowed so the model isn't silently fed a blank answer. */
  dismissible?: boolean
  /** Controls how options with descriptions are rendered:
   *  - `compact` (default): label and description on the same line,
   *    right-padded into two aligned columns. Best for short labels.
   *  - `compact-vertical`: description on a separate indented line
   *    below the label. Best for long descriptions (askUser). */
  layout?: 'compact' | 'compact-vertical'
}
