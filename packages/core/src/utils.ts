// @x-code-cli/core — Shared utilities and constants
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** Project-local config directory name */
export const XCODE_DIR = '.x-code'

/** Global config directory (~/.x-code) */
export const GLOBAL_XCODE_DIR = path.join(os.homedir(), '.x-code')

// ── Debug log (shared by core + cli) ────────────────────────────────────
// Turn on with `DEBUG_STDOUT=1`. Writes to ~/.x-code/logs/debug.log so a
// globally-installed CLI doesn't pollute the user's project tree and so
// every invocation across every cwd ends up in one greppable file.
//
// Sync I/O is deliberate: callers are in hot paths (every stream chunk,
// every tool call) and we want on-disk ordering to match real-time event
// order. An async queue would reorder entries under backpressure.
//
// Performance: we keep ONE open file descriptor for the lifetime of the
// process (writeSync ~10μs) instead of appendFileSync (~100μs each — open +
// write + close per call). On rotation we close + reopen. The fd is
// inherited at exit and closed by the kernel, so no explicit teardown.
//
// Bounded per-line size: a single `stream.tool-result` from reading a large
// file can otherwise consume tens of KB in one entry, eating most of the
// 1MB budget in a handful of lines. We hard-cap each entry at MAX_LINE_BYTES
// so even chatty turns yield at least ~250 lines/MB of grep-able context.
//
// Rotation: two-file scheme (debug.log + debug.log.1). When the active file
// reaches MAX_LOG_BYTES we rename it over .1 and start fresh, capping total
// disk use at ~2× MAX_LOG_BYTES. Same shape pip / Cargo / npm use for cache
// logs at small scale — simple enough we don't need a logrotate cron.
const DEBUG = process.env.DEBUG_STDOUT === '1'
/** Per-file size cap. Total disk = 2× this (active + rotated). 10MB chosen
 *  so a typical multi-turn agent run (~85KB/turn × 50–100 turns) lands
 *  entirely in the active file — grep/tail doesn't need to span rotation
 *  for normal debugging. The combined 20MB is still small enough to attach
 *  to a bug report verbatim. */
const MAX_LOG_BYTES = 10 * 1024 * 1024
/** Per-entry truncation cap. Bounds worst-case line size — without this a
 *  single huge tool-result could eat the whole budget in a handful of
 *  entries. 1KB keeps the worst case at ~5k lines per file (~10k across
 *  rotation) while still leaving room for short stack traces and small
 *  payloads in full. Typical lines are <200 bytes, so the realistic per-
 *  file count is in the tens of thousands. */
const MAX_LINE_BYTES = 1024

const LOG_DIR = path.join(GLOBAL_XCODE_DIR, 'logs')
const LOG_FILE = path.join(LOG_DIR, 'debug.log')
const LOG_FILE_OLD = path.join(LOG_DIR, 'debug.log.1')

/** In-memory byte counter for the active file. Avoids a statSync on every
 *  hot-path debugLog call — only hit disk when initialising or rotating. */
let currentLogBytes = -1
let logFd: number | null = null

function ensureLogReady(): void {
  if (logFd !== null) return
  fsSync.mkdirSync(LOG_DIR, { recursive: true })
  if (currentLogBytes < 0) {
    try {
      currentLogBytes = fsSync.statSync(LOG_FILE).size
    } catch {
      // File doesn't exist yet — open() in 'a' mode will create it.
      currentLogBytes = 0
    }
  }
  logFd = fsSync.openSync(LOG_FILE, 'a')
}

function rotateIfNeeded(nextWriteBytes: number): void {
  if (currentLogBytes + nextWriteBytes < MAX_LOG_BYTES) return
  try {
    if (logFd !== null) {
      fsSync.closeSync(logFd)
      logFd = null
    }
    // rename silently overwrites the previous .1 on POSIX. On Windows
    // rename fails if the target exists, so unlink first; missing .1
    // is fine (no previous rotation).
    try {
      fsSync.unlinkSync(LOG_FILE_OLD)
    } catch {
      /* no previous rotation — fine */
    }
    fsSync.renameSync(LOG_FILE, LOG_FILE_OLD)
  } catch {
    // Rotation failed (file locked, FS full, etc.) — reset and let the
    // next ensureLogReady() reopen fresh. We'd rather lose history than
    // spam errors.
  }
  currentLogBytes = 0
}

/** Truncate `s` to at most `maxBytes` UTF-8 bytes, appending a marker noting
 *  how many bytes were dropped. The cheap `length * 4` upper bound short-
 *  circuits the common ASCII case (most debug content) without paying for
 *  Buffer.byteLength on every line. */
function truncateForLog(s: string, maxBytes: number): string {
  if (s.length * 4 <= maxBytes) return s
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s
  const sliceLen = Math.max(0, maxBytes - 64)
  const truncated = s.slice(0, sliceLen)
  const dropped = s.length - sliceLen
  return `${truncated}…<+${dropped}c truncated>`
}

/** Narrow opt-in: when set by the CLI's `--plugin-debug` flag (or
 *  `XC_PLUGIN_DEBUG=1`), debugLog also mirrors lines tagged with one of
 *  the plugin-related prefixes to stderr, so the user can watch plugin
 *  / hook / marketplace activity live without `DEBUG_STDOUT=1`'s firehose.
 *  Kept as module state instead of an arg to debugLog so existing call
 *  sites don't need touching. */
let pluginDebugMirror = false
const PLUGIN_DEBUG_TAG_PREFIXES = ['plugins.', 'plugin.', 'hooks.', 'marketplace.']

export function setPluginDebugMirror(enabled: boolean): void {
  pluginDebugMirror = enabled
}

function isPluginRelatedTag(tag: string): boolean {
  for (const p of PLUGIN_DEBUG_TAG_PREFIXES) {
    if (tag.startsWith(p)) return true
  }
  return false
}

export function debugLog(tag: string, content: string): void {
  const mirrorToStderr = pluginDebugMirror && isPluginRelatedTag(tag)
  if (!DEBUG && !mirrorToStderr) return
  try {
    const safeContent = truncateForLog(content, MAX_LINE_BYTES)
    const ts = new Date().toISOString()
    // `JSON.stringify(content)` quotes newlines/tabs so the full payload
    // lands on ONE line in the log — much easier to grep across turns,
    // and multi-line text-deltas don't visually merge with neighbours.
    const line = `[${ts}] ${tag} ${JSON.stringify(safeContent)}\n`
    if (DEBUG) {
      const bytes = Buffer.byteLength(line, 'utf8')
      rotateIfNeeded(bytes)
      ensureLogReady()
      if (logFd !== null) {
        fsSync.writeSync(logFd, line)
        currentLogBytes += bytes
      }
    }
    if (mirrorToStderr) {
      // Use the raw fd to avoid Node's stderr stream buffering — we want
      // each line to appear immediately even if the agent loop is busy.
      try {
        fsSync.writeSync(2, line)
      } catch {
        // stderr write failure shouldn't crash the agent
      }
    }
  } catch {
    // best effort — never crash the agent just because we can't log
  }
}

/** Check if a file exists */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

/** Read a file safely, return empty string on error */
export async function readFileSafe(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf-8')
  } catch {
    return ''
  }
}

/** Read and parse a JSON file, return null on error */
export async function readJsonSafe(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8')
    return JSON.parse(content) as Record<string, unknown>
  } catch {
    return null
  }
}
