const ESC = '\x1b'
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

export type DecodedPromptInput = { type: 'normal' | 'paste'; value: string }

function suffixPrefixLength(value: string, marker: string): number {
  const max = Math.min(value.length, marker.length - 1)
  for (let length = max; length > 0; length--) {
    if (value.endsWith(marker.slice(0, length))) return length
  }
  return 0
}

/** Incrementally tokenizes terminal input without assuming Node chunk
 * boundaries align with keys or bracketed-paste markers. */
export class PromptInputDecoder {
  private pending = ''
  private pasteBuffer = ''
  private paste = false

  push(value: string): DecodedPromptInput[] {
    this.pending += value
    return this.drain(false)
  }

  flush(): DecodedPromptInput[] {
    return this.drain(true)
  }

  reset(): void {
    this.pending = ''
    this.pasteBuffer = ''
    this.paste = false
  }

  hasPending(): boolean {
    return this.pending.length > 0
  }

  inPaste(): boolean {
    return this.paste
  }

  private drain(flush: boolean): DecodedPromptInput[] {
    const out: DecodedPromptInput[] = []
    while (this.pending.length > 0) {
      if (this.paste) {
        const end = this.pending.indexOf(PASTE_END)
        if (end >= 0) {
          this.pasteBuffer += this.pending.slice(0, end)
          out.push({ type: 'paste', value: this.pasteBuffer.replace(/\r\n?/g, '\n') })
          this.pasteBuffer = ''
          this.paste = false
          this.pending = this.pending.slice(end + PASTE_END.length)
          continue
        }
        if (flush) {
          this.pasteBuffer += this.pending
          this.pending = ''
          if (this.pasteBuffer) out.push({ type: 'paste', value: this.pasteBuffer.replace(/\r\n?/g, '\n') })
          this.pasteBuffer = ''
          this.paste = false
          break
        }
        const keep = suffixPrefixLength(this.pending, PASTE_END)
        this.pasteBuffer += this.pending.slice(0, this.pending.length - keep)
        this.pending = this.pending.slice(this.pending.length - keep)
        break
      }

      if (this.pending.startsWith(PASTE_START)) {
        this.pending = this.pending.slice(PASTE_START.length)
        this.paste = true
        continue
      }
      if (!flush && PASTE_START.startsWith(this.pending)) break

      if (this.pending[0] === ESC) {
        if (this.pending.length === 1 && !flush) break
        if (this.pending.startsWith(ESC + ESC)) {
          out.push({ type: 'normal', value: ESC + ESC })
          this.pending = this.pending.slice(2)
          continue
        }
        if (this.pending[1] === '[') {
          let end = 2
          while (end < this.pending.length && !/[\x40-\x7e]/.test(this.pending[end]!)) end++
          if (end >= this.pending.length && !flush) break
          const length = end < this.pending.length ? end + 1 : this.pending.length
          out.push({ type: 'normal', value: this.pending.slice(0, length) })
          this.pending = this.pending.slice(length)
          continue
        }
        const length = Math.min(2, this.pending.length)
        out.push({ type: 'normal', value: this.pending.slice(0, length) })
        this.pending = this.pending.slice(length)
        continue
      }

      const first = this.pending.charCodeAt(0)
      if (first <= 0x1f || first === 0x7f || (first >= 0x80 && first <= 0x9f)) {
        out.push({ type: 'normal', value: this.pending[0]! })
        this.pending = this.pending.slice(1)
        continue
      }

      let end = 1
      while (end < this.pending.length) {
        const unit = this.pending.charCodeAt(end)
        if (unit === 0x1b || unit <= 0x1f || unit === 0x7f || (unit >= 0x80 && unit <= 0x9f)) break
        end++
      }
      out.push({ type: 'normal', value: this.pending.slice(0, end) })
      this.pending = this.pending.slice(end)
    }
    return out
  }
}
