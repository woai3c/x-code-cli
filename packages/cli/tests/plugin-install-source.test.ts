import { resolvePluginInstallSource } from '../src/plugins/install-source.js'

describe('resolvePluginInstallSource', () => {
  it('resolves marketplace references through the shared lookup', async () => {
    const findPlugin = vi.fn(async () => ({
      entry: { source: { kind: 'github' as const, owner: 'acme', repo: 'demo' } },
    }))

    await expect(resolvePluginInstallSource('demo@official', findPlugin)).resolves.toEqual({
      ok: true,
      source: { kind: 'github', owner: 'acme', repo: 'demo' },
      marketplace: 'official',
      expectedName: 'demo',
    })
    expect(findPlugin).toHaveBeenCalledWith('demo@official')
  })

  it('reports a missing marketplace plugin without guessing another source kind', async () => {
    await expect(resolvePluginInstallSource('demo@official', async () => undefined)).resolves.toEqual({
      ok: false,
      code: 'plugin-not-found',
      pluginName: 'demo',
      marketplace: 'official',
    })
  })

  it('parses GitHub shorthand and generic git URLs', async () => {
    await expect(resolvePluginInstallSource('github:acme/demo#v1')).resolves.toEqual({
      ok: true,
      source: { kind: 'github', owner: 'acme', repo: 'demo', ref: 'v1' },
      marketplace: 'local',
    })
    await expect(resolvePluginInstallSource('https://example.com/acme/demo.git')).resolves.toEqual({
      ok: true,
      source: { kind: 'git', url: 'https://example.com/acme/demo.git' },
      marketplace: 'local',
    })
    await expect(resolvePluginInstallSource('git@example.com:acme/demo.git')).resolves.toEqual({
      ok: true,
      source: { kind: 'git', url: 'git@example.com:acme/demo.git' },
      marketplace: 'local',
    })
  })

  it.each(['./plugin', '..\\plugin', '/tmp/plugin', 'C:\\plugins\\demo', '\\\\server\\share\\demo'])(
    'recognizes local paths on every supported platform: %s',
    async (source) => {
      await expect(resolvePluginInstallSource(source)).resolves.toEqual({
        ok: true,
        source: { kind: 'local', path: source },
        marketplace: 'local',
      })
    },
  )

  it('returns structured failures for invalid input', async () => {
    await expect(resolvePluginInstallSource('github:missing-repo')).resolves.toEqual({
      ok: false,
      code: 'invalid-github-source',
    })
    await expect(resolvePluginInstallSource('demo')).resolves.toEqual({
      ok: false,
      code: 'unrecognized-source',
      source: 'demo',
    })
  })
})
