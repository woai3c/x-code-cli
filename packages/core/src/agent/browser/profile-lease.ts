// @x-code-cli/core — Cross-process ownership for Playwright's persistent
// browser profile. The pinned MCP server derives one profile per browser
// channel + workspace, but only discovers contention after trying to launch
// Chrome. Taking a small lease in that exact profile directory lets a second
// xc process fail early with a useful message while retaining login state.
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { BrowserConfig } from '../../config/index.js'
import { type FileLockLease, acquireFileLock } from '../../utils/file-lock.js'

const PROFILE_LOCK_FILE = '.x-code-profile.lock'

function browserProfileToken(browser: BrowserConfig['browser']): string {
  // @playwright/mcp maps its `chromium` option to the chrome-for-testing
  // channel before constructing the persistent-profile directory name.
  return browser === 'chromium' ? 'chrome-for-testing' : (browser ?? 'chrome')
}

function playwrightProfilesRoot(): string {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright-mcp')
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright-mcp')
  }
  // The MCP SDK's safe stdio environment passes HOME but not XDG_CACHE_HOME,
  // so the spawned pinned server resolves this exact fallback on Linux.
  return path.join(os.homedir(), '.cache', 'ms-playwright-mcp')
}

/** Mirror @playwright/mcp@0.0.79's default persistent-profile derivation.
 *  Keeping this next to PLAYWRIGHT_MCP_PACKAGE makes a future version bump
 *  review the path algorithm and the lease together. */
export function managedBrowserProfileDirectory(
  config: BrowserConfig,
  cwd = process.cwd(),
  profilesRoot = playwrightProfilesRoot(),
): string {
  const workspaceHash = createHash('sha256').update(cwd).digest('hex').slice(0, 7)
  return path.join(profilesRoot, `mcp-${browserProfileToken(config.browser)}-${workspaceHash}`)
}

/** Acquire ownership before spawning the default persistent browser. Custom
 *  commands own their own lifecycle/profile and intentionally skip this. */
export async function acquireBrowserProfileLease(
  config: BrowserConfig,
  options: { cwd?: string; profilesRoot?: string } = {},
): Promise<FileLockLease> {
  const profileDirectory = managedBrowserProfileDirectory(config, options.cwd, options.profilesRoot)
  await fs.mkdir(profileDirectory, { recursive: true })
  const lease = await acquireFileLock(path.join(profileDirectory, PROFILE_LOCK_FILE), {
    staleMs: 30_000,
  })
  if (!lease) {
    throw new Error(
      'The managed browser profile for this workspace is already in use by another xc process. ' +
        'Close the other xc session and retry; X-Code will not replace the persistent signed-in profile with a temporary one.',
    )
  }
  return lease
}
