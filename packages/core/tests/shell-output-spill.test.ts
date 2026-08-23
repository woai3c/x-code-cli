import fs from 'node:fs/promises'

import { ShellOutputSpill } from '../src/tools/shell-session/output-spill.js'

const temporaryFiles: string[] = []

afterEach(async () => {
  await Promise.all(temporaryFiles.splice(0).map((filePath) => fs.rm(filePath, { force: true })))
})

describe('ShellOutputSpill', () => {
  it('does not create a file while output stays within both inline budgets', async () => {
    const spill = new ShellOutputSpill({ maxInlineBytes: 32, maxInlineLines: 2 })
    spill.append('hello\nworld')

    expect(await spill.close()).toEqual({})
  })

  it('preserves every UTF-8 byte when the byte budget is exceeded', async () => {
    const spill = new ShellOutputSpill({ maxInlineBytes: 5, maxInlineLines: 100 })
    spill.append('ab')
    spill.append('中')
    spill.append('cd')
    spill.append('ef')

    const snapshot = await spill.flush()
    expect(snapshot.fullOutputPath).toBeDefined()
    temporaryFiles.push(snapshot.fullOutputPath!)
    expect(await fs.readFile(snapshot.fullOutputPath!, 'utf8')).toBe('ab中cdef')

    await spill.close()
  })

  it('spills output when the line budget is exceeded', async () => {
    const spill = new ShellOutputSpill({ maxInlineBytes: 1_000, maxInlineLines: 2 })
    spill.append('first\n')
    expect(await spill.flush()).toEqual({})

    spill.append('second\n')
    const snapshot = await spill.close()
    expect(snapshot.fullOutputPath).toBeDefined()
    temporaryFiles.push(snapshot.fullOutputPath!)
    expect(await fs.readFile(snapshot.fullOutputPath!, 'utf8')).toBe('first\nsecond\n')
  })

  it('can lower the inline budget after output has completed', async () => {
    const spill = new ShellOutputSpill({ maxInlineBytes: 100, maxInlineLines: 100 })
    spill.append('completed output')
    expect(await spill.close()).toEqual({})

    spill.lowerMaxInlineBytes(5)
    const snapshot = await spill.flush()
    expect(snapshot.fullOutputPath).toBeDefined()
    temporaryFiles.push(snapshot.fullOutputPath!)
    expect(await fs.readFile(snapshot.fullOutputPath!, 'utf8')).toBe('completed output')
  })
})
