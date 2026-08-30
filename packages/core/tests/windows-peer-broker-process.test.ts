import { execFile } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

describe('Windows peer broker process wrapper', () => {
  it('survives a broker exit while writes are queued', async () => {
    const moduleUrl = pathToFileURL(path.resolve('packages/core/dist/peers/windows-peer-broker-process.js')).href
    const script = `
      import { spawn } from 'node:child_process'
      import { spawnWindowsPeerBrokerProcess } from ${JSON.stringify(moduleUrl)}

      let streamErrors = 0
      const broker = spawnWindowsPeerBrokerProcess({
        artifact: { executablePath: process.execPath },
        mode: 'broker',
        spawnBroker(_file, _args, spawnOptions) {
          return spawn(
            process.execPath,
            ['--input-type=module', '--eval', 'process.stdin.destroy(); setTimeout(() => process.exit(0), 20)'],
            spawnOptions,
          )
        },
        debugKey: 'test.windows-peer-broker-process',
        onFrame() {},
        onError() {
          streamErrors++
        },
      })
      const payload = Buffer.alloc(131_072)
      const writes = Array.from({ length: 16 }, (_, index) =>
        broker.send({ kind: 1, operationId: index + 1, payload }),
      )
      await Promise.allSettled(writes)
      await broker.closed
      await new Promise((resolve) => setTimeout(resolve, 50))
      process.stdout.write('survived:' + streamErrors)
    `

    const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', script], {
      timeout: 10_000,
      windowsHide: true,
    })

    expect(stdout).toMatch(/^survived:[1-9]\d*$/)
  })
})
