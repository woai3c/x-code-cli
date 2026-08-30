import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createPeerService } from '../src/peers/service.js'
import type { PeerTransport } from '../src/peers/transport.js'

describe('PeerService transport compatibility', () => {
  it('uses the Unix registry kind for an injected legacy transport without metadata', async () => {
    const previousHome = process.env.X_CODE_HOME
    const testHome =
      process.platform === 'win32'
        ? path.join(os.homedir(), `.x-code-peer-legacy-${randomUUID()}`)
        : await fs.mkdtemp(path.join(os.tmpdir(), 'x-code-peer-legacy-'))
    process.env.X_CODE_HOME = testHome
    const transport: PeerTransport = {
      async listen(options) {
        return {
          address: options.address,
          async close() {},
        }
      },
      async request() {
        throw new Error('not used')
      },
    }
    const service = createPeerService({ enabled: true, name: 'legacy-transport', transport })

    try {
      await service.start()
      expect(service.isAvailable(), service.getUnavailableReason()).toBe(true)
    } finally {
      await service.shutdown()
      if (previousHome === undefined) delete process.env.X_CODE_HOME
      else process.env.X_CODE_HOME = previousHome
      await fs.rm(testHome, { recursive: true, force: true })
    }
  })
})
