// @x-code/core — Tool registry (unified export)

import { readFile } from './read-file.js'
import { writeFile } from './write-file.js'
import { edit } from './edit.js'
import { shell } from './shell.js'
import { glob } from './glob.js'
import { grep } from './grep.js'
import { listDir } from './list-dir.js'
import { webSearch } from './web-search.js'
import { webFetch } from './web-fetch.js'
import { askUser } from './ask-user.js'
import { saveKnowledge } from './save-knowledge.js'
import { enterPlanMode } from './enter-plan-mode.js'
import { exitPlanMode } from './exit-plan-mode.js'

export const toolRegistry = {
  readFile,
  writeFile,
  edit,
  shell,
  glob,
  grep,
  listDir,
  webSearch,
  webFetch,
  askUser,
  saveKnowledge,
  enterPlanMode,
  exitPlanMode,
}

export {
  readFile,
  writeFile,
  edit,
  shell,
  glob,
  grep,
  listDir,
  webSearch,
  webFetch,
  askUser,
  saveKnowledge,
  enterPlanMode,
  exitPlanMode,
}

/** Max characters for tool results before truncation */
export const MAX_TOOL_RESULT_CHARS = 30000

/** Truncate tool result, keeping head and tail */
export function truncateToolResult(result: string): string {
  if (result.length <= MAX_TOOL_RESULT_CHARS) return result
  const half = Math.floor(MAX_TOOL_RESULT_CHARS / 2)
  const truncatedLines = result.slice(half, -half).split('\n').length
  return result.slice(0, half) + `\n\n... [truncated ${truncatedLines} lines] ...\n\n` + result.slice(-half)
}
