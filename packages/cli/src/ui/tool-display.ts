// @x-code-cli/cli — Shared tool display utilities (re-exports from utils.ts)
//
// All implementations now live in utils.ts. This module exists as a
// stable re-export path so existing consumers don't need to change
// their imports.
export {
  isCollapsibleReadOnlyTool,
  getToolLabel,
  getToolInputPreview,
  getToolResultSummary,
  formatReadGroupSummary,
} from './utils.js'
export type { ReadGroupSummary } from './utils.js'
