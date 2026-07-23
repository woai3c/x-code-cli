import { afterEach, describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { ensureProjectStorageDir } from '../src/project-storage.js'

const tempDirs: string[] = []
const COMMENT = '\n# X-Code CLI project-local state (sessions, history, plans, memory, and local settings)'

async function makeProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'x-code-project-storage-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe('ensureProjectStorageDir', () => {
  it('appends .x-code when it creates the project directory for the first time', async () => {
    const cwd = await makeProject()
    await fs.writeFile(path.join(cwd, '.gitignore'), 'node_modules\n', 'utf-8')

    await ensureProjectStorageDir(path.join(cwd, '.x-code'))

    expect((await fs.stat(path.join(cwd, '.x-code'))).isDirectory()).toBe(true)
    await expect(fs.readFile(path.join(cwd, '.gitignore'), 'utf-8')).resolves.toBe(
      `node_modules\n${COMMENT}\n.x-code\n`,
    )
  })

  it('appends .x-code when a nested storage path creates the top-level directory', async () => {
    const cwd = await makeProject()
    await fs.writeFile(path.join(cwd, '.gitignore'), 'node_modules\n', 'utf-8')

    await ensureProjectStorageDir(path.join(cwd, '.x-code', 'sessions'))

    expect((await fs.stat(path.join(cwd, '.x-code', 'sessions'))).isDirectory()).toBe(true)
    await expect(fs.readFile(path.join(cwd, '.gitignore'), 'utf-8')).resolves.toBe(
      `node_modules\n${COMMENT}\n.x-code\n`,
    )
  })

  it('does not update .gitignore when .x-code already exists', async () => {
    const cwd = await makeProject()
    await fs.mkdir(path.join(cwd, '.x-code'))
    await fs.writeFile(path.join(cwd, '.gitignore'), 'node_modules\n', 'utf-8')

    await ensureProjectStorageDir(path.join(cwd, '.x-code'))

    await expect(fs.readFile(path.join(cwd, '.gitignore'), 'utf-8')).resolves.toBe('node_modules\n')
  })

  it('does not create a .gitignore when one does not exist', async () => {
    const cwd = await makeProject()

    await ensureProjectStorageDir(path.join(cwd, '.x-code'))

    await expect(fs.stat(path.join(cwd, '.x-code'))).resolves.toBeDefined()
    await expect(fs.access(path.join(cwd, '.gitignore'))).rejects.toThrow()
  })

  it.each(['.x-code', '.x-code/', '/.x-code', '/.x-code/'])(
    'does not duplicate the equivalent rule %s',
    async (rule) => {
      const cwd = await makeProject()
      await fs.writeFile(path.join(cwd, '.gitignore'), `${rule}\n`, 'utf-8')

      await ensureProjectStorageDir(path.join(cwd, '.x-code'))

      await expect(fs.readFile(path.join(cwd, '.gitignore'), 'utf-8')).resolves.toBe(`${rule}\n`)
    },
  )

  it('preserves CRLF and separates a file without a trailing newline', async () => {
    const cwd = await makeProject()
    await fs.writeFile(path.join(cwd, '.gitignore'), 'node_modules\r\ndist', 'utf-8')

    await ensureProjectStorageDir(path.join(cwd, '.x-code'))

    await expect(fs.readFile(path.join(cwd, '.gitignore'), 'utf-8')).resolves.toBe(
      `node_modules\r\ndist\r\n${COMMENT}\r\n.x-code\r\n`,
    )
  })
})
