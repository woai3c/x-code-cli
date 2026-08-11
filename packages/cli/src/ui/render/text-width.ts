// @x-code-cli/cli — CJK-aware visual width helpers.
//
// JavaScript's `string.length` counts UTF-16 code units, but a terminal
// renders East-Asian Wide characters in two cells. Mixing the two breaks
// any code that pads to a column or truncates to a column budget — the
// row overshoots its width, the terminal wraps, and the user sees a
// spurious blank "row" plus misaligned columns on every line that
// contains CJK / fullwidth punctuation.
//
// Ranges follow Unicode East_Asian_Width=Wide / Fullwidth (the subset
// terminals universally render double-width). Single source of truth
// for every renderer — chat-input frame, scrollback diff (render-diff),
// and markdown table layout (render-markdown). Adding a range in one
// place but not the other used to re-create the alignment drift this
// module was extracted to fix.

function isWide(cp: number): boolean {
  return (
    // CJK Unified Ideographs + Extension A + Compatibility Ideographs
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    // Hangul: Jamo + Syllables
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    // Halfwidth and Fullwidth Forms (fullwidth half: 0xff00-0xff60, signs: 0xffe0-0xffe6)
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    // CJK Extensions B-F
    (cp >= 0x20000 && cp <= 0x2fa1f) ||
    // CJK Radicals Supplement + Kangxi Radicals + Ideographic Description
    (cp >= 0x2e80 && cp <= 0x2fff) ||
    // CJK Symbols + Hiragana + Katakana + Bopomofo + Enclosed CJK + Compatibility
    (cp >= 0x3000 && cp <= 0x303f) ||
    (cp >= 0x3040 && cp <= 0x30ff) ||
    (cp >= 0x3100 && cp <= 0x312f) ||
    (cp >= 0x3200 && cp <= 0x32ff) ||
    (cp >= 0x3300 && cp <= 0x33ff) ||
    // Yi Syllables + Yi Radicals
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    // CJK Compatibility Forms
    (cp >= 0xfe30 && cp <= 0xfe4f)
  )
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const emojiRe = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u
const markRe = /^\p{Mark}+$/u

export function graphemes(str: string): string[] {
  return [...graphemeSegmenter.segment(str)].map((part) => part.segment)
}

export function graphemeAt(str: string, index: number): string | null {
  for (const part of graphemeSegmenter.segment(str)) {
    if (part.index === index) return part.segment
    if (part.index > index) break
    if (index < part.index + part.segment.length) return part.segment
  }
  return null
}

export function previousGraphemeBoundary(str: string, index: number): number {
  let previous = 0
  for (const part of graphemeSegmenter.segment(str)) {
    if (part.index >= index) break
    previous = part.index
  }
  return previous
}

export function nextGraphemeBoundary(str: string, index: number): number {
  for (const part of graphemeSegmenter.segment(str)) {
    const end = part.index + part.segment.length
    if (part.index >= index || end > index) return end
  }
  return str.length
}

export function charWidth(ch: string): number {
  if (!ch) return 0
  if (emojiRe.test(ch)) return 2
  for (const codePoint of ch) {
    if (markRe.test(codePoint)) continue
    return isWide(codePoint.codePointAt(0)!) ? 2 : 1
  }
  return 0
}

export function visualWidth(str: string): number {
  let w = 0
  for (const ch of graphemes(str)) w += charWidth(ch)
  return w
}

/** Take the longest prefix of `str` whose visual width fits in `maxCols`.
 *  Stops BEFORE a wide char that would straddle the boundary — never
 *  splits a wide cell across two rows. */
export function sliceByWidth(str: string, maxCols: number): string {
  let w = 0
  let i = 0
  for (const ch of graphemes(str)) {
    const cw = charWidth(ch)
    if (w + cw > maxCols) break
    w += cw
    i += ch.length
  }
  return str.slice(0, i)
}
