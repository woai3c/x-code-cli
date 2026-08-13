import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { clearPluginEntry, setPluginEnabled } from '../src/plugins/enable-state.js'
import { mutateSettingsFile } from '../src/settings-io.js'

describe('settings file mutations', () => {
  it('does not create or rewrite a file for a no-op mutation', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-settings-io-'))
    const file = path.join(root, 'missing', 'settings.json')

    expect(await mutateSettingsFile(file, () => false)).toBe(false)
    await expect(fs.access(file)).rejects.toMatchObject({ code: 'ENOENT' })

    const pluginFile = path.join(root, '.x-code', 'settings.local.json')
    await fs.mkdir(path.dirname(pluginFile), { recursive: true })
    await fs.writeFile(pluginFile, '{"enabledPlugins":{"demo@local":true}}\n', 'utf-8')
    const before = await fs.readFile(pluginFile, 'utf-8')

    expect(await setPluginEnabled('demo@local', 'project', true, root)).toBe('noop')
    expect(await fs.readFile(pluginFile, 'utf-8')).toBe(before)
  })

  it('preserves unrelated settings while updating and clearing plugin state', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-settings-plugin-'))
    const file = path.join(root, '.x-code', 'settings.local.json')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(
      file,
      JSON.stringify({ disabledSkills: ['review'], enabledPlugins: { 'old@local': true } }),
      'utf-8',
    )

    expect(await setPluginEnabled('demo@local', 'project', false, root)).toBe('changed')
    let settings = JSON.parse(await fs.readFile(file, 'utf-8')) as Record<string, unknown>
    expect(settings).toEqual({
      disabledSkills: ['review'],
      enabledPlugins: { 'old@local': true, 'demo@local': false },
    })

    expect(await clearPluginEntry('demo@local', 'project', root)).toBe('changed')
    expect(await clearPluginEntry('old@local', 'project', root)).toBe('changed')
    settings = JSON.parse(await fs.readFile(file, 'utf-8')) as Record<string, unknown>
    expect(settings).toEqual({ disabledSkills: ['review'] })
  })
})
