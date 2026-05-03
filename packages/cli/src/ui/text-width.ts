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
// terminals universally render double-width). Mirrors the table the
// chat-input frame uses to measure the prompt area; centralized here so
// scrollback rendering (render-diff.ts) and the input frame stay in
// sync — adding a range in one place but not the other would re-create
// the alignment drift this module was extracted to fix.

export function isWide(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0xff01 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x2fa1f) ||
    (cp >= 0x3000 && cp <= 0x303f) ||
    (cp >= 0x3040 && cp <= 0x30ff) ||
    (cp >= 0x3100 && cp <= 0x312f) ||
    (cp >= 0x3200 && cp <= 0x32ff) ||
    (cp >= 0x3300 && cp <= 0x33ff)
  )
}

export function charWidth(ch: string): number {
  return isWide(ch.codePointAt(0)!) ? 2 : 1
}

export function visualWidth(str: string): number {
  let w = 0
  for (const ch of str) w += charWidth(ch)
  return w
}

/** Take the longest prefix of `str` whose visual width fits in `maxCols`.
 *  Stops BEFORE a wide char that would straddle the boundary — never
 *  splits a wide cell across two rows. */
export function sliceByWidth(str: string, maxCols: number): string {
  let w = 0
  let i = 0
  for (const ch of str) {
    const cw = charWidth(ch)
    if (w + cw > maxCols) break
    w += cw
    i += ch.length
  }
  return str.slice(0, i)
}
