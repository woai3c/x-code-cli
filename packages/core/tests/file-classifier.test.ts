import { zipSync } from 'fflate'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { inspectFile } from '../src/agent/file-classifier.js'

function wavHeader(): Buffer {
  const buffer = Buffer.alloc(44)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36, 4)
  buffer.write('WAVEfmt ', 8, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(16_000, 24)
  buffer.writeUInt32LE(32_000, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36, 'ascii')
  return buffer
}

function utf16be(text: string): Buffer {
  const little = Buffer.from(text, 'utf16le')
  for (let index = 0; index < little.length; index += 2) {
    const first = little[index]!
    little[index] = little[index + 1]!
    little[index + 1] = first
  }
  return Buffer.concat([Buffer.from([0xfe, 0xff]), little])
}

let tempDir: string

beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-classifier-'))
})

afterAll(async () => {
  await fs.rm(tempDir, { recursive: true, force: true })
})

describe('inspectFile', () => {
  it('classifies extensionless UTF-8 as text', async () => {
    const file = path.join(tempDir, 'script')
    await fs.writeFile(file, '#!/usr/bin/env node\nconsole.log("ok")\n')
    expect(await inspectFile(file)).toMatchObject({ kind: 'text', textEncoding: 'utf-8' })
  })

  it('recognizes UTF-16LE and UTF-16BE BOM text before applying the NUL rule', async () => {
    const little = path.join(tempDir, 'little.txt')
    const big = path.join(tempDir, 'big.txt')
    await fs.writeFile(little, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('你好\nworld', 'utf16le')]))
    await fs.writeFile(big, utf16be('你好\nworld'))

    expect(await inspectFile(little)).toMatchObject({ kind: 'text', textEncoding: 'utf-16le' })
    expect(await inspectFile(big)).toMatchObject({ kind: 'text', textEncoding: 'utf-16be' })
  })

  it('fails closed for NUL-heavy and known binary files', async () => {
    const nul = path.join(tempDir, 'nul.txt')
    const executable = path.join(tempDir, 'program.exe')
    await fs.writeFile(nul, Buffer.from([0x61, 0, 0x62, 0, 0, 0x63]))
    await fs.writeFile(executable, Buffer.from('MZ\u0000\u0000binary', 'binary'))
    expect((await inspectFile(nul)).kind).toBe('binary')
    expect((await inspectFile(executable)).kind).toBe('binary')
  })

  it('does not let a UTF-8 BOM override NUL or PDF signatures', async () => {
    const nul = path.join(tempDir, 'bom-nul.txt')
    const pdf = path.join(tempDir, 'bom-pdf.txt')
    const bom = Buffer.from([0xef, 0xbb, 0xbf])
    await fs.writeFile(nul, Buffer.concat([bom, Buffer.from([0x61, 0, 0x62, 0])]))
    await fs.writeFile(pdf, Buffer.concat([bom, Buffer.from('%PDF-1.4\n')]))

    expect((await inspectFile(nul)).kind).toBe('binary')
    expect(await inspectFile(pdf)).toMatchObject({ kind: 'pdf', mediaType: 'application/pdf' })
  })

  it('lets magic bytes override a misleading extension', async () => {
    const fakePng = path.join(tempDir, 'archive.png')
    const actualPng = path.join(tempDir, 'actual.bin')
    const actualPdf = path.join(tempDir, 'scan.bin')
    const actualAudio = path.join(tempDir, 'recording.dat')
    const { Jimp } = await import('jimp')
    const png = await new Jimp({ width: 2, height: 2, color: 0xffffffff }).getBuffer('image/png')
    await Promise.all([
      fs.writeFile(fakePng, Buffer.from(zipSync({ 'a.txt': Buffer.from('hello') }))),
      fs.writeFile(actualPng, png),
      fs.writeFile(actualPdf, '%PDF-1.4\n'),
      fs.writeFile(actualAudio, wavHeader()),
    ])

    expect((await inspectFile(fakePng)).kind).toBe('binary')
    expect((await inspectFile(actualPng)).kind).toBe('image')
    expect((await inspectFile(actualPdf)).kind).toBe('pdf')
    expect((await inspectFile(actualAudio)).kind).toBe('audio')
  })

  it('allows ordinary whitespace controls in text', async () => {
    const file = path.join(tempDir, 'controls.txt')
    await fs.writeFile(file, 'one\ttwo\nthree\fnext\r\n')
    expect((await inspectFile(file)).kind).toBe('text')
  })

  it('does not reject UTF-8 split at the nominal sample boundary', async () => {
    const file = path.join(tempDir, 'utf8-boundary.txt')
    await fs.writeFile(file, Buffer.concat([Buffer.from('a'.repeat(32 * 1024 - 1)), Buffer.from('é')]))

    expect(await inspectFile(file)).toMatchObject({ kind: 'text', textEncoding: 'utf-8' })
  })

  it('does not reject a UTF-16 surrogate pair split at the nominal sample boundary', async () => {
    const file = path.join(tempDir, 'utf16-boundary.txt')
    const body = Buffer.from('a'.repeat(16_382) + '😀', 'utf16le')
    await fs.writeFile(file, Buffer.concat([Buffer.from([0xff, 0xfe]), body]))

    expect(await inspectFile(file)).toMatchObject({ kind: 'text', textEncoding: 'utf-16le' })
  })
})
