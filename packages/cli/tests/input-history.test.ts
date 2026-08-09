import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { mkdtempSync, rmSync } from 'node:fs'
import fs from 'node:fs/promises'
import { appendFile, mkdir, open, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { appendInputHistory, loadInputHistory } from '../src/ui/chat-input/input-history.js'

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'xc-input-history-'))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

function entry(index: number, padding = '') {
  return { text: `${index}${padding}`, pasted: {}, ts: index }
}

describe('input history persistence', () => {
  it('loads only the latest 100 valid entries', async () => {
    const file = path.join(tempDir, '.x-code', 'history.jsonl')
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, Array.from({ length: 150 }, (_, index) => JSON.stringify(entry(index))).join('\n') + '\n')

    const loaded = await loadInputHistory(tempDir)

    expect(loaded).toHaveLength(100)
    expect(loaded[0]?.text).toBe('50')
    expect(loaded.at(-1)?.text).toBe('149')
  })

  it('does not read a large history file into memory in full', async () => {
    const file = path.join(tempDir, '.x-code', 'history.jsonl')
    await mkdir(path.dirname(file), { recursive: true })
    const handle = await open(file, 'w')
    await handle.truncate(100 * 1024 * 1024)
    await handle.close()
    const tail = Array.from({ length: 100 }, (_, index) => JSON.stringify(entry(index))).join('\n')
    await appendFile(file, `\n${tail}\n`)
    const readFileSpy = vi.spyOn(fs, 'readFile')

    const loaded = await loadInputHistory(tempDir)

    expect(readFileSpy).not.toHaveBeenCalled()
    expect(loaded).toHaveLength(100)
    expect(loaded.at(-1)?.text).toBe('99')
    readFileSpy.mockRestore()
  })

  it('compacts an oversized file to the latest 500 entries', async () => {
    const file = path.join(tempDir, '.x-code', 'history.jsonl')
    await mkdir(path.dirname(file), { recursive: true })
    const padding = `-${'x'.repeat(3_600)}`
    const initial = Array.from({ length: 600 }, (_, index) => JSON.stringify(entry(index, padding))).join('\n')
    await writeFile(file, `${initial}\n`)

    await appendInputHistory(entry(600, padding), tempDir)

    const lines = (await readFile(file, 'utf-8')).trim().split('\n')
    expect(lines).toHaveLength(500)
    expect(JSON.parse(lines[0]!).ts).toBe(101)
    expect(JSON.parse(lines.at(-1)!).ts).toBe(600)
  })

  it('keeps the original history usable when atomic replacement fails', async () => {
    const file = path.join(tempDir, '.x-code', 'history.jsonl')
    await mkdir(path.dirname(file), { recursive: true })
    const handle = await open(file, 'w')
    await handle.truncate(2 * 1024 * 1024 + 1)
    await handle.close()
    await appendFile(file, `\n${JSON.stringify(entry(1))}\n`)
    const renameSpy = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('rename failed'))

    await appendInputHistory(entry(2), tempDir)

    expect((await loadInputHistory(tempDir)).at(-1)?.text).toBe('2')
    renameSpy.mockRestore()
  })
})
