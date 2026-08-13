import type { PeerService, PeerServiceOptions } from '@x-code-cli/core'

import { resolveCliPeerMessagingConfig, startCliPeerService } from '../src/peer-lifecycle.js'

function fakeService(start: () => Promise<void> = async () => {}): PeerService {
  return { start } as PeerService
}

describe('CLI peer lifecycle', () => {
  it('resolves only inbound policy fields and ignores the removed enabled setting', () => {
    expect(resolveCliPeerMessagingConfig({ enabled: false, inbound: 'hold', dialogExpiryMs: 60_000 })).toEqual({
      inbound: 'hold',
      dialogExpiryMs: 60_000,
    })
    expect(resolveCliPeerMessagingConfig({ enabled: true, inbound: 'refuse' })).toEqual({
      inbound: 'refuse',
      dialogExpiryMs: 300_000,
    })
  })

  it.each([
    { label: 'print mode', printMode: true, name: 'worker' },
    { label: 'unnamed interactive mode', printMode: false, name: undefined },
  ])('does not construct a service in $label', async ({ printMode, name }) => {
    const factory = vi.fn()
    const service = await startCliPeerService(
      {
        printMode,
        name,
        cwd: '/project',
        getPermissionClass: () => 'prompted',
      },
      factory,
    )
    expect(service).toBeNull()
    expect(factory).not.toHaveBeenCalled()
  })

  it('constructs and starts the service before returning it for App wiring', async () => {
    const events: string[] = []
    const service = fakeService(async () => {
      events.push('start')
    })
    const factory = vi.fn((options: PeerServiceOptions) => {
      events.push('create')
      expect(options).toMatchObject({
        enabled: true,
        name: 'frontend',
        cwd: '/project',
        config: { inbound: 'hold', dialogExpiryMs: 60_000 },
      })
      expect(options.getPermissionClass?.()).toBe('bypass')
      return service
    })

    const result = await startCliPeerService(
      {
        userConfig: { enabled: false, inbound: 'hold', dialogExpiryMs: 60_000 },
        printMode: false,
        name: 'frontend',
        cwd: '/project',
        getPermissionClass: () => 'bypass',
      },
      factory,
    )

    expect(result).toBe(service)
    expect(events).toEqual(['create', 'start'])
  })

  it('starts the peer service when the interactive session has a name', async () => {
    const service = fakeService()
    const factory = vi.fn((options: PeerServiceOptions) => {
      expect(options).toMatchObject({ enabled: true, name: 'coder' })
      return service
    })

    await expect(
      startCliPeerService(
        {
          printMode: false,
          name: 'coder',
          cwd: '/project',
          getPermissionClass: () => 'prompted',
        },
        factory,
      ),
    ).resolves.toBe(service)
    expect(factory).toHaveBeenCalledOnce()
  })

  it('keeps ordinary CLI startup alive and retains a constructed service for shutdown after start failure', async () => {
    const createFailure = await startCliPeerService(
      {
        printMode: false,
        name: 'bad\u0000name',
        cwd: '/project',
        getPermissionClass: () => 'prompted',
      },
      () => {
        throw new Error('invalid name')
      },
    )
    const failedToStart = fakeService(async () => Promise.reject(new Error('bind failed')))
    const startFailure = await startCliPeerService(
      {
        printMode: false,
        name: 'worker',
        cwd: '/project',
        getPermissionClass: () => 'prompted',
      },
      () => failedToStart,
    )

    expect(createFailure).toBeNull()
    expect(startFailure).toBe(failedToStart)
  })
})
