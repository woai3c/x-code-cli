import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { acquireBrowserProfileLease, managedBrowserProfileDirectory } from '../src/agent/browser/profile-lease.js'

describe('managed browser profile lease', () => {
  it('mirrors the pinned Playwright MCP workspace/channel profile names', () => {
    const profilesRoot = path.join('/tmp', 'profiles')
    expect(path.basename(managedBrowserProfileDirectory({}, '/workspace/app', profilesRoot))).toMatch(
      /^mcp-chrome-[a-f0-9]{7}$/,
    )
    expect(
      path.basename(managedBrowserProfileDirectory({ browser: 'chromium' }, '/workspace/app', profilesRoot)),
    ).toMatch(/^mcp-chrome-for-testing-[a-f0-9]{7}$/)
    expect(
      path.basename(managedBrowserProfileDirectory({ browser: 'msedge' }, '/workspace/app', profilesRoot)),
    ).toMatch(/^mcp-msedge-[a-f0-9]{7}$/)
  })

  it('excludes a second process-equivalent owner until the first releases', async () => {
    const profilesRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-browser-profile-'))
    try {
      const options = { cwd: '/workspace/app', profilesRoot }
      const first = await acquireBrowserProfileLease({}, options)
      await expect(acquireBrowserProfileLease({}, options)).rejects.toThrow(/already in use/)

      await first.release()
      const second = await acquireBrowserProfileLease({}, options)
      await second.release()
    } finally {
      await fs.rm(profilesRoot, { recursive: true, force: true })
    }
  })

  it('recovers a lock left behind by a dead process', async () => {
    const profilesRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-browser-profile-'))
    try {
      const options = { cwd: '/workspace/app', profilesRoot }
      const profile = managedBrowserProfileDirectory({}, options.cwd, profilesRoot)
      await fs.mkdir(profile, { recursive: true })
      await fs.writeFile(
        path.join(profile, '.x-code-profile.lock'),
        JSON.stringify({
          ownerId: 'dead-owner',
          pid: 2_147_483_647,
          hostname: os.hostname(),
          startedAt: new Date(0).toISOString(),
        }),
      )

      const recovered = await acquireBrowserProfileLease({}, options)
      await recovered.release()
    } finally {
      await fs.rm(profilesRoot, { recursive: true, force: true })
    }
  })

  it('does not let concurrent stale-lock recovery produce two owners', async () => {
    const profilesRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-browser-profile-'))
    try {
      const options = { cwd: '/workspace/app', profilesRoot }
      const profile = managedBrowserProfileDirectory({}, options.cwd, profilesRoot)
      await fs.mkdir(profile, { recursive: true })
      await fs.writeFile(
        path.join(profile, '.x-code-profile.lock'),
        JSON.stringify({
          ownerId: 'dead-owner',
          pid: 2_147_483_647,
          hostname: os.hostname(),
          startedAt: new Date(0).toISOString(),
        }),
      )

      const attempts = await Promise.allSettled([
        acquireBrowserProfileLease({}, options),
        acquireBrowserProfileLease({}, options),
      ])
      const acquired = attempts.filter(
        (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireBrowserProfileLease>>> =>
          result.status === 'fulfilled',
      )
      expect(acquired).toHaveLength(1)
      expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(1)
      await acquired[0]!.value.release()
    } finally {
      await fs.rm(profilesRoot, { recursive: true, force: true })
    }
  })
})
