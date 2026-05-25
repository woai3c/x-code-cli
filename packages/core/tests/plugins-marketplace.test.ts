// Tests for marketplace parsing + known_marketplaces.json registry
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  MarketplaceParseError,
  RESERVED_MARKETPLACE_NAMES,
  addKnownMarketplace,
  parseMarketplace,
  readAllCachedMarketplaces,
  readKnownMarketplaces,
  removeKnownMarketplace,
  resolveCloneUrl,
} from '../src/plugins/marketplace.js'
import { knownMarketplacesPath, marketplaceIndexPath } from '../src/plugins/paths.js'

let originalPluginsDir: string | undefined

beforeEach(async () => {
  originalPluginsDir = process.env.XC_PLUGINS_DIR
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-plugins-mp-test-'))
  process.env.XC_PLUGINS_DIR = tmp
})

afterEach(() => {
  if (originalPluginsDir === undefined) delete process.env.XC_PLUGINS_DIR
  else process.env.XC_PLUGINS_DIR = originalPluginsDir
})

describe('parseMarketplace', () => {
  it('parses a minimal valid marketplace (legacy {kind} source)', () => {
    const raw = JSON.stringify({
      name: 'official',
      plugins: [{ name: 'linear', source: { kind: 'github', owner: 'foo', repo: 'linear' } }],
    })
    const m = parseMarketplace(raw, 'official')
    expect(m.schemaVersion).toBe('1')
    expect(m.plugins).toHaveLength(1)
    expect(m.plugins[0]!.name).toBe('linear')
  })

  it('normalises every real Claude Code source variant', () => {
    // This is the regression test for the v0.x bug where our schema
    // only accepted {kind: 'git'|'github'|'local'} objects and rejected
    // every real-world Claude Code marketplace. The wire-format shapes
    // below were sampled from anthropics/claude-code and
    // anthropics/claude-plugins-official as of April 2026.
    const raw = JSON.stringify({
      name: 'mixed',
      plugins: [
        { name: 'rel', source: './plugins/rel-one' },
        { name: 'github-short', source: 'github:foo/bar' },
        { name: 'http-git', source: 'https://gitlab.example/x.git' },
        {
          name: 'git-subdir',
          source: {
            source: 'git-subdir',
            url: 'https://github.com/42Crunch-AI/claude-plugins.git',
            path: 'plugins/api',
            ref: 'v1.5.5',
            sha: 'a175b24',
          },
        },
        { name: 'url-form', source: { source: 'url', url: 'https://example.com/x.git', sha: '5ddccc3' } },
        { name: 'github-form', source: { source: 'github', owner: 'foo', repo: 'bar', ref: 'main' } },
        {
          name: 'github-combined',
          source: { source: 'github', repo: 'fullstorydev/fullstory-skills', commit: '1ec5865' },
        },
      ],
    })
    const m = parseMarketplace(raw, 'mixed', {
      marketplaceCloneUrl: 'https://github.com/foo/mixed.git',
    })
    expect(m.plugins).toHaveLength(7)
    expect(m.plugins[0]!.source).toEqual({
      kind: 'git',
      url: 'https://github.com/foo/mixed.git',
      subdir: 'plugins/rel-one',
    })
    expect(m.plugins[1]!.source).toEqual({ kind: 'github', owner: 'foo', repo: 'bar' })
    expect(m.plugins[3]!.source).toEqual({
      kind: 'git',
      url: 'https://github.com/42Crunch-AI/claude-plugins.git',
      subdir: 'plugins/api',
      ref: 'v1.5.5',
      expectedSha: 'a175b24',
    })
    expect(m.plugins[6]!.source).toEqual({
      kind: 'github',
      owner: 'fullstorydev',
      repo: 'fullstory-skills',
      ref: '1ec5865',
    })
  })

  it('relative source without marketplaceCloneUrl context surfaces a helpful error', () => {
    // When marketplace was fetched from a raw HTTPS URL (no repo to
    // subdir into) but the JSON contains "./plugins/foo" entries, the
    // per-entry error should mention the missing context — and the
    // overall parse still throws because no plugin entries succeeded.
    const raw = JSON.stringify({
      name: 'no-ctx',
      plugins: [{ name: 'rel', source: './plugins/foo' }],
    })
    expect(() => parseMarketplace(raw, 'no-ctx')).toThrow(/marketplaceCloneUrl|requires.*clone URL/)
  })

  it('skips individual bad source entries when other entries succeed', () => {
    // Real-world marketplaces sometimes carry one weird entry the
    // schema doesn't recognise — that one should be dropped, not kill
    // the whole catalog.
    const raw = JSON.stringify({
      name: 'mixed-bad',
      plugins: [
        { name: 'good', source: 'github:foo/bar' },
        { name: 'bad', source: { source: 'mysterious-future-form', whatever: 1 } },
      ],
    })
    const m = parseMarketplace(raw, 'mixed-bad')
    expect(m.plugins.map((p) => p.name)).toEqual(['good'])
  })

  it('rejects schema violations with field-path message', () => {
    const raw = JSON.stringify({ name: 'official', plugins: [{ name: 'foo' }] }) // missing source
    try {
      parseMarketplace(raw, 'official')
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(MarketplaceParseError)
      expect((err as Error).message).toContain('plugins.0.source')
    }
  })

  it('captures the optional `sha` integrity pin from every git source shape', () => {
    const raw = JSON.stringify({
      name: 'mixed-sha',
      plugins: [
        {
          name: 'p-git-subdir',
          source: {
            source: 'git-subdir',
            url: 'https://github.com/foo/bar.git',
            path: 'plugins/p',
            ref: 'v1',
            sha: 'a175b24f7b34852b70c78c21545cce8037eb3112',
          },
        },
        {
          name: 'p-git',
          source: { source: 'git', url: 'https://example.com/x.git', sha: '5ddccc3aa1' },
        },
        {
          name: 'p-github',
          source: { source: 'github', owner: 'foo', repo: 'bar', ref: 'main', sha: '1ec5865abc' },
        },
        // No sha — must remain undefined, not coerced to anything
        { name: 'p-no-sha', source: 'github:foo/baz' },
        // Garbage sha — must be dropped, not silently passed to installer
        { name: 'p-bad-sha', source: { source: 'github', owner: 'foo', repo: 'qux', sha: 'not-a-hash' } },
      ],
    })
    const m = parseMarketplace(raw, 'mixed-sha')
    expect(m.plugins).toHaveLength(5)
    expect(m.plugins.find((p) => p.name === 'p-git-subdir')!.source).toMatchObject({
      kind: 'git',
      expectedSha: 'a175b24f7b34852b70c78c21545cce8037eb3112',
    })
    expect(m.plugins.find((p) => p.name === 'p-git')!.source).toMatchObject({
      kind: 'git',
      expectedSha: '5ddccc3aa1',
    })
    expect(m.plugins.find((p) => p.name === 'p-github')!.source).toMatchObject({
      kind: 'github',
      expectedSha: '1ec5865abc',
    })
    const noSha = m.plugins.find((p) => p.name === 'p-no-sha')!.source as { expectedSha?: string }
    expect(noSha.expectedSha).toBeUndefined()
    const badSha = m.plugins.find((p) => p.name === 'p-bad-sha')!.source as { expectedSha?: string }
    expect(badSha.expectedSha).toBeUndefined()
  })

  it('Marketplace.name is the subscription alias (sourceLabel), not the upstream `name`', () => {
    // Regression: the v0.x bug where `parseMarketplace` returned the
    // upstream marketplace.json `name` as `Marketplace.name`, which
    // broke `plugin marketplace info <subscription-alias>` and tagged
    // `plugin search` results with the upstream name instead of the
    // alias the user typed. Storage paths, install ids, and lookups
    // all key off the subscription alias, so the returned Marketplace
    // must do the same.
    const raw = JSON.stringify({
      name: 'claude-plugins-official',
      plugins: [{ name: 'linear', source: 'github:foo/linear' }],
    })
    const m = parseMarketplace(raw, 'anthropic-marketplace')
    expect(m.name).toBe('anthropic-marketplace')
    expect(m.upstreamName).toBe('claude-plugins-official')
  })

  it('upstreamName is undefined when subscription alias matches upstream name', () => {
    const raw = JSON.stringify({
      name: 'community',
      plugins: [{ name: 'foo', source: 'github:foo/bar' }],
    })
    const m = parseMarketplace(raw, 'community')
    expect(m.name).toBe('community')
    expect(m.upstreamName).toBeUndefined()
  })
})

describe('addKnownMarketplace + removeKnownMarketplace', () => {
  it('writes a new entry into known_marketplaces.json', async () => {
    await addKnownMarketplace({ name: 'community', source: 'github:foo/community' })
    const km = await readKnownMarketplaces()
    expect(km.marketplaces).toHaveLength(1)
    expect(km.marketplaces[0]!.name).toBe('community')
  })

  it('is idempotent — re-adding updates the source in place', async () => {
    await addKnownMarketplace({ name: 'community', source: 'github:foo/community' })
    await addKnownMarketplace({ name: 'community', source: 'github:bar/community' })
    const km = await readKnownMarketplaces()
    expect(km.marketplaces).toHaveLength(1)
    expect(km.marketplaces[0]!.source).toBe('github:bar/community')
  })

  it('rejects a reserved name pointing at a non-canonical source', async () => {
    await expect(
      addKnownMarketplace({ name: 'anthropic-marketplace', source: 'github:malicious/marketplace' }),
    ).rejects.toThrow(/reserved/)
  })

  it('accepts a reserved name pointing at the canonical org', async () => {
    const expectedOrg = RESERVED_MARKETPLACE_NAMES['anthropic-marketplace']!
    await addKnownMarketplace({
      name: 'anthropic-marketplace',
      source: `github:${expectedOrg}/claude-plugins-official`,
    })
    const km = await readKnownMarketplaces()
    expect(km.marketplaces[0]!.reservedName).toBe(true)
    expect(km.marketplaces[0]!.officialSource).toBe(expectedOrg)
  })

  it('removes entries', async () => {
    await addKnownMarketplace({ name: 'community', source: 'github:foo/community' })
    expect(await removeKnownMarketplace('community')).toBe('removed')
    expect(await removeKnownMarketplace('community')).toBe('noop')
    const km = await readKnownMarketplaces()
    expect(km.marketplaces).toEqual([])
  })

  it('preserves unrelated fields in known_marketplaces.json on write', async () => {
    // Pre-write a file with extra fields the loader knows nothing about.
    const file = knownMarketplacesPath()
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(
      file,
      JSON.stringify({ marketplaces: [], strictKnownMarketplaces: true, futureField: 42 }, null, 2),
    )
    await addKnownMarketplace({ name: 'community', source: 'github:foo/community' })
    const after = JSON.parse(await fs.readFile(file, 'utf-8')) as Record<string, unknown>
    expect(after.futureField).toBe(42)
    expect(after.strictKnownMarketplaces).toBe(true)
  })
})

describe('readAllCachedMarketplaces', () => {
  it('reads cached marketplace.json for each subscribed marketplace', async () => {
    await addKnownMarketplace({ name: 'community', source: 'github:foo/community' })

    // Hand-place a cached marketplace.json
    const cached = JSON.stringify({
      name: 'community',
      plugins: [{ name: 'foo', source: { kind: 'local', path: '/tmp/foo' } }],
    })
    const idx = marketplaceIndexPath('community')
    await fs.mkdir(path.dirname(idx), { recursive: true })
    await fs.writeFile(idx, cached, 'utf-8')

    const all = await readAllCachedMarketplaces()
    expect(all).toHaveLength(1)
    expect(all[0]!.plugins[0]!.name).toBe('foo')
  })

  it('skips marketplaces with broken cached indexes (one bad does not break others)', async () => {
    await addKnownMarketplace({ name: 'good', source: 'github:foo/good' })
    await addKnownMarketplace({ name: 'broken', source: 'github:foo/broken' })

    const goodIdx = marketplaceIndexPath('good')
    await fs.mkdir(path.dirname(goodIdx), { recursive: true })
    await fs.writeFile(goodIdx, JSON.stringify({ name: 'good', plugins: [] }))

    const brokenIdx = marketplaceIndexPath('broken')
    await fs.mkdir(path.dirname(brokenIdx), { recursive: true })
    await fs.writeFile(brokenIdx, '{ not json', 'utf-8')

    const all = await readAllCachedMarketplaces()
    expect(all.map((m) => m.name)).toEqual(['good'])
  })
})

describe('resolveCloneUrl', () => {
  it('translates github:owner/repo → https URL', () => {
    expect(resolveCloneUrl('github:foo/bar')).toBe('https://github.com/foo/bar.git')
  })

  it('preserves an existing .git suffix as a single suffix', () => {
    // github:foo/bar.git → still ends in single .git, not double
    expect(resolveCloneUrl('github:foo/bar.git')).toBe('https://github.com/foo/bar.git')
  })
})
