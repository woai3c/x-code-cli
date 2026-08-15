import type { ManagedShellProvider } from '../provider.js'
import { PosixProcessGroupProvider } from './posix-process-group.js'
import { PtyShellProvider } from './pty.js'
import { WindowsJobObjectProvider } from './windows-job.js'

let provider: ManagedShellProvider | undefined

export function getManagedShellProvider(): ManagedShellProvider {
  if (!provider) {
    const pipeProvider = process.platform === 'win32' ? new WindowsJobObjectProvider() : new PosixProcessGroupProvider()
    const ptyProvider = new PtyShellProvider()
    provider = {
      spawnManaged(command, options) {
        return (options.tty ? ptyProvider : pipeProvider).spawnManaged(command, options)
      },
    }
  }
  return provider
}
