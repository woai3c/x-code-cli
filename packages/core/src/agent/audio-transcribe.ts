// @x-code-cli/core — Local audio transcription via whisper.cpp
//
// Transcribes local audio files (MP3, WAV, M4A, OGG, FLAC, AAC, AIFF, WMA,
// WebM) using @fugood/whisper.node — a native Node.js binding of whisper.cpp.
// Returns timestamped text segments; only the text is sent to the LLM, never
// the raw audio. The whisper model is auto-downloaded from Hugging Face on
// first use and cached under ~/.x-code/whisper-models/.
//
// Platform support:
//   macOS ARM64  — Metal GPU acceleration
//   macOS x86_64 — CPU only
//   Windows x64  — Vulkan GPU acceleration (optional)
//   Linux x64    — CPU (Vulkan/CUDA optional)
//
// When the native binding is unavailable (unsupported OS/arch, broken install),
// transcribeAudio returns a descriptive error string instead of throwing —
// callers can surface it to the model and the user.
import { closeSync, openSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

import { debugLog, errorMessage, userXcodeDir } from '../utils.js'

// ── stderr suppression ───────────────────────────────────────────────────
// whisper.cpp's C layer (and ggml_metal) writes directly to fd 2 via
// fprintf(stderr, ...).  toggleNativeLog(false) only suppresses the
// whisper-level log callback; lower-level ggml prints (device init,
// metal library load, deallocation, read_audio_data) bypass it entirely.
//
// The only reliable fix: dup the real fd 2 to a backup, then close fd 2
// and open /dev/null so it claims fd 2 (POSIX guarantees open() returns
// the lowest available fd).  Restore by closing fd 2 (/dev/null), then
// reopening the backup via /dev/fd/<N> so it reclaims fd 2.
//
// On Windows (no /dev/fd, no reliable dup-via-open trick), we fall back
// to a no-op — the native logs are not a fatal problem, just visual noise.

const DEV_NULL = process.platform === 'win32' ? 'NUL' : '/dev/null'
const FD_SELF_PREFIX = process.platform === 'linux' ? '/proc/self/fd/' : '/dev/fd/'
let savedStderrFd: number | null = null
let stderrMuted = false

function muteStderr(): void {
  if (stderrMuted || process.platform === 'win32') return
  try {
    // 1. dup(2) → savedStderrFd  (opening /dev/fd/2 is equivalent to dup(2))
    savedStderrFd = openSync(`${FD_SELF_PREFIX}2`, 'w')
    // 2. close(2)
    closeSync(2)
    // 3. open /dev/null → gets fd 2 (lowest available)
    const nullFd = openSync(DEV_NULL, 'w')
    if (nullFd !== 2) {
      // Unexpected: fd 2 wasn't the lowest available. Undo and bail.
      closeSync(nullFd)
      // Reopen stderr from the backup
      const restored = openSync(`${FD_SELF_PREFIX}${savedStderrFd}`, 'w')
      if (restored !== 2) closeSync(restored)
      closeSync(savedStderrFd!)
      savedStderrFd = null
      return
    }
    stderrMuted = true
  } catch {
    savedStderrFd = null
    stderrMuted = false
  }
}

function unmuteStderr(): void {
  if (!stderrMuted || savedStderrFd === null) return
  try {
    // 1. close fd 2 (/dev/null)
    closeSync(2)
    // 2. reopen from backup → gets fd 2
    const restored = openSync(`${FD_SELF_PREFIX}${savedStderrFd}`, 'w')
    if (restored !== 2) {
      // Shouldn't happen, but close the stray fd
      closeSync(restored)
    }
  } catch {
    /* best-effort */
  }
  try {
    closeSync(savedStderrFd)
  } catch {
    /* ignore */
  }
  savedStderrFd = null
  stderrMuted = false
}

// ── Supported audio formats ──────────────────────────────────────────────
const AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.wav',
  '.m4a',
  '.ogg',
  '.flac',
  '.aac',
  '.aiff',
  '.aif',
  '.wma',
  '.webm',
  '.opus',
])

export function isAudioFile(filePath: string): boolean {
  return AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

/** Whisper model variants, ordered small→large.
 *  Default is `tiny` — only ~75 MB to download, fast on CPU, and good
 *  enough for a CLI assistant. Users who need better accuracy for
 *  non-English or complex audio can override via env or option. */
const WHISPER_MODELS = {
  'tiny.en': 'ggml-tiny.en.bin',
  tiny: 'ggml-tiny.bin',
  'base.en': 'ggml-base.en.bin',
  base: 'ggml-base.bin',
  'small.en': 'ggml-small.en.bin',
  small: 'ggml-small.bin',
} as const

type WhisperModelName = keyof typeof WHISPER_MODELS

const DEFAULT_MODEL: WhisperModelName = (process.env.X_CODE_WHISPER_MODEL as WhisperModelName | undefined) ?? 'tiny'
const HUGGINGFACE_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'

function modelsDir(): string {
  return path.join(userXcodeDir(), 'whisper-models')
}

function modelPath(model: WhisperModelName): string {
  return path.join(modelsDir(), WHISPER_MODELS[model])
}

// ── Model download ───────────────────────────────────────────────────────

// Per-chunk stall timeout: if no data arrives for this long we assume
// the connection is dead.  This is NOT a total download timeout — a
// slow-but-steady 75 MB download is fine; only a fully stalled network
// triggers this.
const STALL_TIMEOUT_MS = 30_000

interface EnsureModelOptions {
  abortSignal?: AbortSignal
  /** Called for every notable step (start download, loading model, ready).
   *  Callers choose how to surface these: tool-progress updates the same
   *  spinner line in-place (readFile), while file-ingest appends a new
   *  message per call. To avoid flooding the UI with a new line per 10%,
   *  intermediate download percentages are only sent to debugLog. */
  onProgress?: (message: string) => void
}

async function ensureModel(model: WhisperModelName, options?: EnsureModelOptions): Promise<string> {
  const dest = modelPath(model)
  try {
    await fs.access(dest)
    return dest
  } catch {
    // not downloaded yet
  }

  // Clean up a stale partial download from a previous interrupted attempt.
  const tmpDest = `${dest}.tmp`
  await fs.rm(tmpDest, { force: true })

  await fs.mkdir(modelsDir(), { recursive: true })

  const filename = WHISPER_MODELS[model]
  const url = `${HUGGINGFACE_BASE}/${filename}`
  debugLog('audio-transcribe', `downloading model ${filename} from ${url}`)

  const dlCmd =
    process.platform === 'win32'
      ? `  curl.exe -L -o "${dest}" "${url}"\n` +
        `  # Or in PowerShell:\n` +
        `  Invoke-WebRequest -Uri "${url}" -OutFile "${dest}"`
      : `  curl -L -o "${dest}" "${url}"`
  const manualHint =
    `You can also download it manually:\n${dlCmd}\n` +
    `Or set X_CODE_WHISPER_MODEL=tiny.en for a smaller (~39 MB) English-only model.`

  options?.onProgress?.(`First-time setup: downloading whisper model "${model}" — press Esc to cancel.\n${manualHint}`)

  const response = await fetch(url, { signal: options?.abortSignal })
  if (!response.ok || !response.body) {
    throw new Error(
      `Failed to download whisper model ${filename}: ${response.status} ${response.statusText}\n${manualHint}`,
    )
  }

  const totalBytes = Number(response.headers.get('content-length') || 0)
  let downloadedBytes = 0
  let lastPctReported = -1

  const writer = (await import('node:fs')).createWriteStream(tmpDest)
  const reader = response.body.getReader()
  try {
    for (;;) {
      if (options?.abortSignal?.aborted) {
        throw new DOMException('Download aborted', 'AbortError')
      }

      // Stall detection: if no data arrives within STALL_TIMEOUT_MS the
      // connection is dead — don't hang forever.
      let stallTimer: ReturnType<typeof setTimeout> | undefined
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          stallTimer = setTimeout(
            () =>
              reject(new Error(`Download stalled — no data received for ${STALL_TIMEOUT_MS / 1000}s.\n${manualHint}`)),
            STALL_TIMEOUT_MS,
          )
        }),
      ])
      clearTimeout(stallTimer)
      const { done, value } = chunk
      if (done) break
      writer.write(value)
      downloadedBytes += value.byteLength
      if (totalBytes > 0) {
        const pct = Math.floor((downloadedBytes / totalBytes) * 100)
        if (pct >= lastPctReported + 5) {
          lastPctReported = pct
          const mb = (downloadedBytes / 1024 / 1024).toFixed(1)
          const totalMb = (totalBytes / 1024 / 1024).toFixed(1)
          debugLog('audio-transcribe', `download progress: ${mb}/${totalMb} MB (${pct}%)`)
          options?.onProgress?.(`Downloading whisper model: ${mb}/${totalMb} MB (${pct}%)`)
        }
      }
    }
  } catch (err) {
    writer.destroy()
    await fs.rm(tmpDest, { force: true })
    throw err
  } finally {
    writer.end()
    await new Promise<void>((resolve, reject) => {
      writer.on('finish', resolve)
      writer.on('error', reject)
    })
  }

  await fs.rename(tmpDest, dest)
  debugLog('audio-transcribe', `model saved to ${dest}`)
  options?.onProgress?.(`Whisper model downloaded successfully`)
  return dest
}

// ── Transcription result ─────────────────────────────────────────────────

export interface TranscribeSegment {
  /** Start time in milliseconds */
  t0: number
  /** End time in milliseconds */
  t1: number
  /** Transcribed text for this segment */
  text: string
}

export interface TranscribeAudioResult {
  /** Full transcription text */
  text: string
  /** Timestamped segments */
  segments: TranscribeSegment[]
  /** Detected/specified language */
  language?: string
}

function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const millis = ms % 1000

  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`
}

/** Format transcription result as timestamped text suitable for LLM context. */
export function formatTranscription(result: TranscribeAudioResult, filePath: string): string {
  const header = `Audio transcription: ${filePath}`
  const langLine = result.language ? `Language: ${result.language}` : ''

  if (result.segments.length === 0) {
    return [header, langLine, '', result.text].filter(Boolean).join('\n')
  }

  const lines = result.segments.map(
    (seg) => `[${formatTimestamp(seg.t0)} --> ${formatTimestamp(seg.t1)}] ${seg.text.trim()}`,
  )

  return [header, langLine, '', ...lines].filter(Boolean).join('\n')
}

// ── whisper.node context pool ────────────────────────────────────────────
// Lazy-loaded, auto-released after idle timeout. Similar pattern to the
// shared tesseract.js worker in file-ingest.ts.

type WhisperCtx = Awaited<ReturnType<(typeof import('@fugood/whisper.node'))['initWhisper']>>

const IDLE_MS = 60_000
let sharedCtx: WhisperCtx | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null
let loadedModelPath: string | null = null

async function getContext(model: WhisperModelName, opts?: EnsureModelOptions): Promise<WhisperCtx> {
  const target = await ensureModel(model, opts)

  if (sharedCtx && loadedModelPath === target) {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(releaseContext, IDLE_MS)
    return sharedCtx
  }

  await releaseContext()

  opts?.onProgress?.('Loading whisper model…')
  const whisperModule = await import('@fugood/whisper.node')
  await whisperModule.loadWhisperModule()
  await whisperModule.toggleNativeLog(false)
  // Redirect fd 2 → /dev/null for the duration of initWhisper, which
  // triggers ggml_metal_device_init / whisper_init_from_file prints that
  // bypass the whisper log callback.
  muteStderr()
  try {
    sharedCtx = await whisperModule.initWhisper({ filePath: target, useGpu: true })
  } finally {
    unmuteStderr()
  }
  loadedModelPath = target
  idleTimer = setTimeout(releaseContext, IDLE_MS)
  return sharedCtx
}

async function releaseContext(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  if (sharedCtx) {
    muteStderr()
    try {
      await sharedCtx.release().catch(() => {})
    } finally {
      unmuteStderr()
    }
    sharedCtx = null
    loadedModelPath = null
  }
}

// ── Public API ───────────────────────────────────────────────────────────

/** Check whether whisper.node native binding is available on this platform. */
export async function isWhisperAvailable(): Promise<boolean> {
  try {
    await import('@fugood/whisper.node')
    return true
  } catch {
    return false
  }
}

export interface TranscribeOptions {
  /** Override the default model. Defaults to 'base'. */
  model?: WhisperModelName
  /** Force a specific language (ISO 639-1 code, e.g. 'en', 'zh'). Auto-detect if omitted. */
  language?: string
  /** Abort signal to cancel transcription. */
  abortSignal?: AbortSignal
  /** Progress callback (0–100). */
  onProgress?: (pct: number) => void
  /** UI notice callback — displayed to the user for download progress, model loading, etc. */
  onNotice?: (message: string) => void
}

/** Transcribe a local audio file, returning timestamped text segments.
 *  Never throws — returns descriptive error text on failure so callers
 *  can surface it directly to the model. */
export async function transcribeAudio(
  filePath: string,
  options?: TranscribeOptions,
): Promise<TranscribeAudioResult | string> {
  const model = options?.model ?? DEFAULT_MODEL

  // Pre-flight: file exists?
  try {
    await fs.access(filePath)
  } catch {
    return `[Audio transcription failed: file not found — ${filePath}]`
  }

  // Platform check
  const available = await isWhisperAvailable()
  if (!available) {
    return (
      `[Audio transcription unavailable: the whisper.node native binding ` +
      `could not be loaded on this platform (${process.platform}/${process.arch}). ` +
      `Supported: macOS ARM64, Windows x64, Linux x64/ARM64. ` +
      `Install @fugood/whisper.node and its platform package to enable local audio transcription.]`
    )
  }

  try {
    debugLog('audio-transcribe', `starting transcription: ${filePath} (model: ${model})`)

    // onNotice fires for every progress tick — fine for tool-progress
    // (overwrites the same spinner line), but file-ingest appends a new
    // UI message each time. So use onNotice for key milestones only
    // when no dedicated progress sink exists; downstream download ticks
    // always go to onNotice so the readFile spinner stays live.
    const ctx = await getContext(model, {
      abortSignal: options?.abortSignal,
      onProgress: options?.onNotice,
    })
    options?.onNotice?.(`Transcribing audio: ${path.basename(filePath)}…`)

    const transcribeOpts: Parameters<WhisperCtx['transcribeFile']>[1] = {
      temperature: 0,
      onProgress: options?.onProgress,
    }
    if (options?.language) {
      transcribeOpts.language = options.language
    }

    // Mute stderr around transcribeFile() — the native layer prints
    // "read_audio_data: trying to decode with miniaudio" (and similar)
    // directly to fd 2 during audio loading. The mute is scoped to
    // the synchronous portion; the returned promise runs on a worker
    // thread inside the native addon and doesn't write to our fd 2.
    muteStderr()
    let transcribeRet: ReturnType<WhisperCtx['transcribeFile']>
    try {
      transcribeRet = ctx.transcribeFile(filePath, transcribeOpts)
    } finally {
      unmuteStderr()
    }
    const { stop, promise } = transcribeRet

    // Wire abort signal to cancel whisper transcription
    const abortHandler = options?.abortSignal
      ? () => {
          void stop()
        }
      : undefined
    if (abortHandler) {
      options!.abortSignal!.addEventListener('abort', abortHandler, { once: true })
    }

    const result = await promise

    if (abortHandler) {
      options!.abortSignal!.removeEventListener('abort', abortHandler)
    }

    if (result.isAborted) {
      return '[Audio transcription was cancelled.]'
    }

    debugLog('audio-transcribe', `done: ${result.segments.length} segments, lang=${result.language ?? 'auto'}`)

    return {
      text: result.result,
      segments: result.segments.map((s) => ({ t0: s.t0, t1: s.t1, text: s.text })),
      language: result.language,
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return '[Audio transcription was cancelled.]'
    }
    const msg = errorMessage(err)
    debugLog('audio-transcribe', `error: ${msg}`)
    return `[Audio transcription failed: ${msg}]`
  }
}
