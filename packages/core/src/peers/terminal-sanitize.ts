const ESC = 0x1b
const BEL = 0x07
const LF = 0x0a
const DEL = 0x7f
const CSI = 0x9b
const DCS = 0x90
const OSC = 0x9d
const SOS = 0x98
const PM = 0x9e
const APC = 0x9f
const ST = 0x9c

function isBidiControl(codePoint: number): boolean {
  return (
    codePoint === 0x061c ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  )
}

function skipCsi(value: string, start: number): number {
  let index = start
  while (index < value.length) {
    const unit = value.charCodeAt(index)
    if (unit >= 0x40 && unit <= 0x7e) return index + 1
    if (unit < 0x20 || unit > 0x3f) return index
    index++
  }
  return value.length
}

function skipControlString(value: string, start: number): number {
  let index = start
  while (index < value.length) {
    const unit = value.charCodeAt(index)
    if (unit === BEL || unit === ST) return index + 1
    if (unit === ESC && value.charCodeAt(index + 1) === 0x5c) return index + 2
    index++
  }
  return value.length
}

function skipEscape(value: string, start: number): number {
  const next = value.charCodeAt(start + 1)
  if (!Number.isFinite(next)) return value.length
  if (next === 0x5b) return skipCsi(value, start + 2)
  if (next === 0x5d || next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
    return skipControlString(value, start + 2)
  }
  if (next >= 0x20 && next <= 0x2f) {
    let index = start + 2
    while (index < value.length && value.charCodeAt(index) >= 0x20 && value.charCodeAt(index) <= 0x2f) index++
    return index < value.length && value.charCodeAt(index) >= 0x30 && value.charCodeAt(index) <= 0x7e
      ? index + 1
      : value.length
  }
  return next >= 0x30 && next <= 0x7e ? start + 2 : start + 1
}

/**
 * Remove terminal instructions from untrusted text while preserving ordinary
 * Unicode and line structure. CR/CRLF are normalized to LF; every other C0/C1
 * control is removed. Unterminated control strings are discarded through EOF
 * so a truncated OSC/DCS cannot become active when adjacent output is written.
 */
export function stripTerminalControls(input: string): string {
  const value = input.replace(/\r\n?/g, '\n')
  let output = ''
  let index = 0
  while (index < value.length) {
    const unit = value.charCodeAt(index)
    if (unit === ESC) {
      index = skipEscape(value, index)
      continue
    }
    if (unit === CSI) {
      index = skipCsi(value, index + 1)
      continue
    }
    if (unit === OSC || unit === DCS || unit === SOS || unit === PM || unit === APC) {
      index = skipControlString(value, index + 1)
      continue
    }
    if (unit <= 0x1f || unit === DEL || (unit >= 0x80 && unit <= 0x9f)) {
      if (unit === LF) output += '\n'
      index++
      continue
    }
    const codePoint = value.codePointAt(index)!
    if (!isBidiControl(codePoint)) output += String.fromCodePoint(codePoint)
    index += codePoint > 0xffff ? 2 : 1
  }
  return output
}
