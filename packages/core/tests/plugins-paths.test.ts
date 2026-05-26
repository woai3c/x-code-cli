import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import path from 'node:path'

import {
  installedPluginsPath,
  knownMarketplacesPath,
  marketplaceDir,
  pluginCacheDir,
  pluginDataDir,
  pluginsRoot,
} from '../src/plugins/paths.js'

describe('plugins/paths honors X_CODE_HOME', () => {
  const originalHome = process.env.X_CODE_HOME
  const originalPluginsDir = process.env.XC_PLUGINS_DIR

  beforeEach(() => {
    delete process.env.X_CODE_HOME
    delete process.env.XC_PLUGINS_DIR
  })

  afterEach(() => {
    if (originalHome === undefined) delete process.env.X_CODE_HOME
    else process.env.X_CODE_HOME = originalHome
    if (originalPluginsDir === undefined) delete process.env.XC_PLUGINS_DIR
    else process.env.XC_PLUGINS_DIR = originalPluginsDir
  })

  it('routes pluginsRoot through X_CODE_HOME when set', () => {
    process.env.X_CODE_HOME = '/tmp/xc-sandbox'
    expect(pluginsRoot()).toBe(path.join('/tmp/xc-sandbox', 'plugins'))
  })

  it('XC_PLUGINS_DIR still wins over X_CODE_HOME (plugin-specific is more specific)', () => {
    process.env.X_CODE_HOME = '/tmp/home'
    process.env.XC_PLUGINS_DIR = '/tmp/just-plugins'
    expect(pluginsRoot()).toBe('/tmp/just-plugins')
  })

  it('downstream path helpers inherit the X_CODE_HOME redirect', () => {
    // The actual side-finding: an `xc plugin list` under X_CODE_HOME=tmp
    // was still reading from ~/.x-code/plugins/installed_plugins.json
    // because pluginsRoot() called the frozen USER_XCODE_DIR constant.
    process.env.X_CODE_HOME = '/tmp/xc-sandbox'
    const root = '/tmp/xc-sandbox/plugins'
    expect(knownMarketplacesPath()).toBe(path.join(root, 'known_marketplaces.json'))
    expect(installedPluginsPath()).toBe(path.join(root, 'installed_plugins.json'))
    expect(marketplaceDir('anthropic')).toBe(path.join(root, 'marketplaces', 'anthropic'))
    expect(pluginCacheDir('m', 'p', '1.0.0')).toBe(path.join(root, 'cache', 'm', 'p', '1.0.0'))
    expect(pluginDataDir('foo@bar')).toBe(path.join(root, 'data', 'foo@bar'))
  })

  it('falls through to ~/.x-code/plugins when no override is set', () => {
    // Don't pin an exact string (HOME varies across machines); just assert
    // the suffix and that we didn't pick up a stray override.
    expect(pluginsRoot().endsWith(path.join('.x-code', 'plugins'))).toBe(true)
  })
})
