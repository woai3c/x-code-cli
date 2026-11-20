import { describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import path from 'node:path'

import { submitInput, withTui } from './test-context.js'

describe('TUI /rewind workflow', () => {
  it('restores modified workspace files and rewinds conversation history before the next prompt', async () => {
    let targetFile = ''
    await withTui(
      'rewind-code-and-conversation',
      [],
      async ({ harness, provider, workspace }) => {
        targetFile = path.join(workspace.cwd, 'notes.txt')
        provider.enqueue(
          {
            type: 'tool-call',
            name: 'writeFile',
            input: { filePath: targetFile, content: 'mutated by agent\n' },
            finalText: 'mutation-complete',
          },
          {
            type: 'completion',
            text: 'fresh-branch-complete',
          },
        )

        await submitInput(harness, 'overwrite notes please')
        await harness.waitForText('Would you like to write the following file?')
        harness.write('y')
        await harness.waitForText('mutation-complete')
        expect(await fs.readFile(targetFile, 'utf-8')).toBe('mutated by agent\n')

        await submitInput(harness, '/rewind')
        await harness.waitForScreen(
          (screen) => screen.includes('Pick a checkpoint to rewind to'),
          'checkpoint picker visible',
        )
        harness.key('enter')

        await harness.waitForScreen(
          (screen) =>
            screen.includes('What would you like to restore?') && screen.includes('Restore code and conversation'),
          'restore mode picker visible',
        )
        harness.key('enter')

        await harness.waitForText('Files and conversation restored')
        expect(await fs.readFile(targetFile, 'utf-8')).toBe('initial safe content\n')

        await submitInput(harness, 'start fresh question')
        await harness.waitForText('fresh-branch-complete')

        const requests = provider.mainRequests()
        const latestPayload = requests.at(-1)?.rawBody ?? ''
        expect(latestPayload).toContain('start fresh question')
        expect(latestPayload).not.toContain('overwrite notes please')
        expect(latestPayload).not.toContain('mutation-complete')
      },
      {
        beforeStart: async (workspace) => {
          await fs.writeFile(path.join(workspace.cwd, 'notes.txt'), 'initial safe content\n', 'utf-8')
        },
      },
    )
  })
})
