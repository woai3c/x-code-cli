import path from 'node:path'

import { quoteWindowsCommandArgument } from './windows-supervisor-protocol.js'

export function defaultWindowsPowerShellExecutable(): string {
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

export function powerShellWrapper(command: string): string {
  const encodedCommand = Buffer.from(command, 'utf16le').toString('base64')
  return [
    '[Console]::InputEncoding = [System.Text.Encoding]::UTF8',
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    "$ProgressPreference = 'SilentlyContinue'",
    `$__xc_command = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedCommand}'))`,
    '& ([ScriptBlock]::Create($__xc_command))',
    '$__ec = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 }',
    'exit $__ec',
  ].join('; ')
}

export function powerShellCommandLine(executable: string, command: string): string {
  // Redirected Windows PowerShell serializes errors as CLIXML with
  // -EncodedCommand. Decoding a fixed quoted wrapper keeps stderr textual.
  return [executable, '-NoProfile', '-NonInteractive', '-Command', powerShellWrapper(command)]
    .map(quoteWindowsCommandArgument)
    .join(' ')
}
