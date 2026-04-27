// @x-code-cli/core — Tool registry (unified export)
import { askUser } from './ask-user.js'
import { edit } from './edit.js'
import { enterPlanMode } from './enter-plan-mode.js'
import { exitPlanMode } from './exit-plan-mode.js'
import { glob } from './glob.js'
import { grep } from './grep.js'
import { listDir } from './list-dir.js'
import { readFile } from './read-file.js'
import { saveKnowledge } from './save-knowledge.js'
import { shell } from './shell.js'
import { todoWrite } from './todo-write.js'
import { webFetch } from './web-fetch.js'
import { webSearch } from './web-search.js'
import { writeFile } from './write-file.js'

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
  todoWrite,
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
  todoWrite,
}

export {
  MAX_TOOL_RESULT_LINES,
  MAX_TOOL_RESULT_BYTES,
  MAX_AGGREGATE_TOOL_RESULT_BYTES,
  truncateToolResult,
} from './truncate.js'
export type { TruncateOptions } from './truncate.js'
