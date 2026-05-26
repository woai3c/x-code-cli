// @x-code-cli/core — MCP project-level trust gate
//
// A `.x-code/config.json` checked into a git repo can declare MCP servers
// with arbitrary `command` strings — i.e. cloning a hostile repo and
// launching the CLI would silently spawn whatever that command says.
// Before honouring any project-level mcpServers block, we therefore
// require an explicit consent step keyed to the absolute project path.
//
// Persistence file: ~/.x-code/trusted-projects.json (mode 0600).
// Format: { trusted: [{ path: <absolute>, trustedAt: <ISO> }, ...] }
//
// User config (~/.x-code/config.json) is NOT subject to this gate —
// the user wrote it themselves; trust is implicit.
import fs from 'node:fs/promises'
import path from 'node:path'

import { userXcodeDir } from '../utils.js'

function trustedFile(): string {
  return path.join(userXcodeDir(), 'trusted-projects.json')
}

interface TrustedEntry {
  path: string
  trustedAt: string
}

interface TrustedStore {
  trusted: TrustedEntry[]
}

/** Normalise a path for stable comparison across platforms.
 *  Absolute + resolved + lowercased on Windows (case-insensitive FS),
 *  preserved case on macOS/Linux. */
function normalize(p: string): string {
  const resolved = path.resolve(p)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

async function readStore(): Promise<TrustedStore> {
  try {
    const raw = await fs.readFile(trustedFile(), 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as TrustedStore).trusted)) {
      return parsed as TrustedStore
    }
  } catch {
    // missing file or malformed — start fresh
  }
  return { trusted: [] }
}

async function writeStore(store: TrustedStore): Promise<void> {
  await fs.mkdir(userXcodeDir(), { recursive: true })
  // Atomic write: tmp + rename. Avoids a half-written file if the process
  // is killed mid-write (the trust file is small but the principle holds —
  // we never want a corrupted JSON to lock the user out of MCP).
  const tmp = trustedFile() + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(store, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 })
  await fs.rename(tmp, trustedFile())
}

export async function isProjectTrusted(projectPath: string): Promise<boolean> {
  const normalized = normalize(projectPath)
  const store = await readStore()
  return store.trusted.some((e) => normalize(e.path) === normalized)
}

export async function trustProject(projectPath: string): Promise<void> {
  const normalized = normalize(projectPath)
  const store = await readStore()
  if (store.trusted.some((e) => normalize(e.path) === normalized)) return
  store.trusted.push({ path: path.resolve(projectPath), trustedAt: new Date().toISOString() })
  await writeStore(store)
}

export type TrustChoice = 'trust' | 'skip' | 'exit'

/** Ask the user whether to trust the project's MCP config.
 *
 *  Caller passes a generic askUser callback (the same one the agent loop
 *  uses for askUser tool calls) so trust prompts render in the same dialog
 *  style as the rest of the UI. We show the actual command strings so the
 *  user can audit what would run.
 *
 *  Returns:
 *    'trust' — user accepted; caller should persist via trustProject(...)
 *    'skip'  — load only user-level mcpServers
 *    'exit'  — caller should terminate the CLI */
export async function promptForTrust(
  projectPath: string,
  serverSummaries: Array<{ name: string; preview: string }>,
  askUser: (question: string, options: Array<{ label: string; description: string }>) => Promise<string>,
): Promise<TrustChoice> {
  const lines = serverSummaries.map((s) => `  • ${s.name}: ${s.preview}`).join('\n')
  const question =
    `This project wants to load ${serverSummaries.length} MCP server(s):\n` +
    lines +
    `\n\nThese commands will run on your machine. Trust only if you trust this project.`

  const answer = await askUser(question, [
    { label: 'Trust this project', description: 'Remember this choice. The project MCP servers will load.' },
    { label: 'Skip project MCP', description: 'Use only user-level mcpServers for this session. No write to disk.' },
    { label: 'Exit X-Code', description: 'Close the CLI without loading any MCP servers.' },
  ])

  const lower = answer.toLowerCase()
  if (lower.startsWith('trust')) return 'trust'
  if (lower.startsWith('exit')) return 'exit'
  return 'skip'
}

/** Build the one-line preview shown for each server in the trust dialog.
 *  Stdio servers expose their full command + args; HTTP servers show the
 *  URL. We intentionally don't truncate — the user needs to see the whole
 *  thing to make an informed call. */
export function buildServerPreview(config: { command?: string; args?: string[]; url?: string }): string {
  if (config.url) return config.url
  if (config.command) {
    const parts = [config.command, ...(config.args ?? [])]
    return parts.join(' ')
  }
  return '(invalid config)'
}
