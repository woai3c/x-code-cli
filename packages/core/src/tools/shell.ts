// @x-code-cli/core — shell tool (cross-platform command execution, no execute — needs permission check)
import { tool } from 'ai'

import { z } from 'zod'

export const shell = tool({
  description: `Execute a shell command and return stdout/stderr. The working directory persists between commands.

IMPORTANT: Avoid using this tool to run grep, rg, cat, head, tail, sed, or awk commands. Instead, use the appropriate dedicated tool — they provide a better user experience:
- File search: Use glob (NOT find or ls)
- Content search: Use grep tool (NOT grep/rg command)
- Read files: Use readFile (NOT cat/head/tail)
- Edit files: Use edit (NOT sed/awk)
- Write files: Use writeFile (NOT echo >/cat <<EOF)

Instructions:
- If your command will create new directories or files, first run ls to verify the parent directory exists and is the correct location.
- Always quote file paths that contain spaces with double quotes.
- When issuing multiple commands: if they are independent, make multiple shell tool calls in a single message for parallelism. If they depend on each other, use '&&' to chain them. Use ';' only when you need sequential execution but don't care if earlier commands fail. Do NOT use newlines to separate commands.
- For git commands: prefer creating a new commit rather than amending. Never skip hooks (--no-verify) unless the user explicitly asks. Before running destructive operations (git reset --hard, git push --force), consider safer alternatives.
- Do not sleep between commands that can run immediately.`,
  inputSchema: z.object({
    command: z.string().describe('The command to execute'),
    timeout: z.number().optional().describe('Timeout in milliseconds (default: 30000)'),
  }),
  // No execute — handled manually in agent loop for permission check + cross-platform shell + streaming
})
