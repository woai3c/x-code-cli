// @x-code-cli/core — Tool registry (unified export)
//
// Memory writes are NOT exposed as a tool — they happen silently via the
// post-turn extractor (`agent/memory-extractor.ts` → `generateText` +
// `Output.object` → `getAutoMemory().add()`). This matches Codex's "main
// agent is read-only for memory" philosophy: any visible memory-write tool
// row in the frame would feel like AI-doing-things-behind-the-user's-back.
// Claude Code takes a different route (memories are markdown files written
// via the generic Write tool, with UI collapse), but that requires a
// separate collapse path we'd rather not maintain.
import { askUser } from './ask-user.js'
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
  enterPlanMode,
  exitPlanMode,
  todoWrite,
}

export { MAX_TOOL_RESULT_LINES, MAX_TOOL_RESULT_BYTES, truncateToolResult } from './truncate.js'
export type { TruncateOptions } from './truncate.js'
