// @x-code-cli/cli — Shell detection and persistence-command helpers.
//
// Shell detection is needed by multiple message-printing functions in
// index.ts. The formatPersistCommand helper extracts the copy-pasted
// switch(shell) block that appeared identically in printNoApiKeyMessage
// and printNoWebSearchKeyHint.

export type ShellType = 'powershell' | 'cmd' | 'bash' | 'zsh' | 'fish' | 'sh'

export function detectShell(): ShellType {
  if (process.platform === 'win32') {
    if (process.env.PSModulePath) return 'powershell'
    return 'cmd'
  }
  const shellPath = process.env.SHELL ?? ''
  const base = shellPath.split('/').pop() ?? ''
  if (base === 'zsh' || base === 'bash' || base === 'fish' || base === 'sh') return base
  if (process.platform === 'darwin') return 'zsh'
  return 'bash'
}

/**
 * Return a copy-pasteable shell command that persists an environment
 * variable. The returned string is the command only (no prefix, no
 * newline) — callers wrap it in chalk color and surrounding prose.
 *
 *   envVar        — e.g. "ANTHROPIC_API_KEY"
 *   exampleValue  — e.g. "sk-ant-..."
 *   shell         — result from detectShell()
 */
export function formatPersistCommand(envVar: string, exampleValue: string, shell: ShellType): string {
  switch (shell) {
    case 'powershell':
      return `[Environment]::SetEnvironmentVariable('${envVar}','${exampleValue}','User')`
    case 'cmd':
      return `setx ${envVar} "${exampleValue}"`
    case 'zsh':
      return `echo 'export ${envVar}=${exampleValue}' >> ~/.zshrc && source ~/.zshrc`
    case 'fish':
      return `set -Ux ${envVar} ${exampleValue}`
    case 'bash':
    default:
      return `echo 'export ${envVar}=${exampleValue}' >> ~/.bashrc && source ~/.bashrc`
  }
}
