import { afterEach, describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { buildKnowledgeContext } from '../src/knowledge/loader.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  delete process.env.X_CODE_HOME
  await Promise.all(temporaryDirectories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe('buildKnowledgeContext deterministic deduplication', () => {
  it('injects byte-identical rule content only once while preserving distinct layers', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'x-code-knowledge-dedupe-'))
    temporaryDirectories.push(root)
    const userDir = path.join(root, 'user')
    const projectDir = path.join(root, 'project')
    await fs.mkdir(userDir, { recursive: true })
    await fs.mkdir(path.join(projectDir, '.git'), { recursive: true })
    process.env.X_CODE_HOME = userDir
    await fs.writeFile(path.join(userDir, 'AGENTS.md'), 'shared exact rule\n', 'utf8')
    await fs.writeFile(path.join(projectDir, 'AGENTS.md'), 'shared exact rule\n', 'utf8')
    await fs.writeFile(path.join(projectDir, 'AGENTS.local.md'), 'distinct local rule\n', 'utf8')

    const context = await buildKnowledgeContext({ cwd: projectDir })

    expect(context.match(/shared exact rule/g)).toHaveLength(1)
    expect(context).toContain('### User Preferences')
    expect(context).not.toContain('### Project AGENTS.md')
    expect(context).toContain('### Local Preferences')
    expect(context).toContain('distinct local rule')
  })
})
