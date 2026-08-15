import type { ShellExecutionResult } from './types.js'

function seconds(milliseconds: number): string {
  return `${(milliseconds / 1000).toFixed(3)}s`
}

function outputBlock(output: string): string {
  return `Output:\n${output.trimEnd() || '(no new output)'}`
}

/** One model-facing representation shared by shell, shellOutput, and killShell. */
export function formatShellExecutionResult(result: ShellExecutionResult): string {
  if (result.cleanupResidual && result.running) {
    const lines = [
      'Command failed to start; process-tree cleanup could not be confirmed.',
      `Residual shell ID: ${result.shellId}`,
      'Use shellOutput or killShell to inspect/retry cleanup.',
    ]
    if (result.failure?.message) lines.push(`Failure: ${result.failure.message}`)
    if (result.output) lines.push(outputBlock(result.output))
    return lines.join('\n')
  }

  const lines = [`Chunk ID: ${result.chunkId}`, `Wall time: ${seconds(result.wallTimeMs)}`]
  if (result.running) {
    if (result.rootExited) {
      lines.push(`Root process exited; managed descendants remain under shell ID ${result.shellId}`)
    } else {
      lines.push(`Process running with shell ID ${result.shellId}`)
    }
    if (result.waitInterrupted) lines.push('Wait interrupted; the managed process is still running.')
    if (result.managerDraining) lines.push('Shell manager is draining this process tree.')
    if (result.failure?.message) lines.push(`Failure: ${result.failure.message}`)
    lines.push(outputBlock(result.output))
    return lines.join('\n')
  }

  if (result.lifecycle === 'spawn-failed') {
    lines.push(`Command failed to start${result.failure?.message ? `: ${result.failure.message}` : '.'}`)
  } else if (result.timedOut) {
    lines.push('Process timed out and its managed process tree exited.')
  } else if (result.signal) {
    lines.push(`Process exited with signal ${result.signal}`)
  } else {
    lines.push(`Process exited with code ${result.exitCode ?? 0}`)
  }
  lines.push(outputBlock(result.output || (result.isError ? '' : 'Done')))
  return lines.join('\n')
}
