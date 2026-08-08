// @x-code-cli/core — Tool registry (unified export)
//
// Memory writes are never exposed as a tool. A durable post-turn worker
// extracts operations after the root loop finishes. The root-only
// memorySearch tool is created dynamically in loop.ts because it needs the
// current MemoryService and LoopState; sub-agents never receive it.
import { askUser } from './ask-user.js'
import { killShell, shellOutput } from './background-shell.js'
import { edit } from './edit.js'
import { enterPlanMode } from './enter-plan-mode.js'
import { exitPlanMode } from './exit-plan-mode.js'
import { glob } from './glob.js'
import { grep } from './grep.js'
import { listDir } from './list-dir.js'
import { readFile } from './read-file.js'
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
  enterPlanMode,
  exitPlanMode,
  todoWrite,
  shellOutput,
  killShell,
}

export { MAX_TOOL_RESULT_BYTES, truncateToolResult } from './truncate.js'
