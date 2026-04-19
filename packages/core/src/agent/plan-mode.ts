// @x-code-cli/core — Plan Mode logic
import fs from 'node:fs/promises'
import path from 'node:path'

const PLANS_DIR = '.x-code/plans'

/** Sanitize a free-form topic into a filesystem-safe kebab-case slug. */
function slugify(topic: string): string {
  return topic
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
}

/** Compact timestamp `YYYYMMDD-HHmmss` used to disambiguate plans with the same topic. */
function compactTimestamp(): string {
  const iso = new Date().toISOString()
  return `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`
}

/**
 * Generate a plan ID. When `topic` is provided (a short description of what
 * the plan addresses), the ID is `<slug>-<timestamp>` so the filename itself
 * tells you what the plan is about. Falls back to pure timestamp otherwise.
 */
export function generatePlanId(topic?: string): string {
  const ts = compactTimestamp()
  const slug = topic ? slugify(topic) : ''
  return slug ? `${slug}-${ts}` : ts
}

/** Get the plan file path */
export function getPlanPath(planId: string): string {
  return path.join(process.cwd(), PLANS_DIR, `${planId}.md`)
}

/** Ensure plans directory exists */
export async function ensurePlansDir(): Promise<void> {
  await fs.mkdir(path.join(process.cwd(), PLANS_DIR), { recursive: true })
}

/** Read a plan file */
export async function readPlan(planId: string): Promise<string | null> {
  try {
    return await fs.readFile(getPlanPath(planId), 'utf-8')
  } catch {
    return null
  }
}

/** List all plan files */
export async function listPlans(): Promise<string[]> {
  try {
    const dir = path.join(process.cwd(), PLANS_DIR)
    const files = await fs.readdir(dir)
    return files.filter((f) => f.endsWith('.md')).map((f) => f.replace('.md', ''))
  } catch {
    return []
  }
}
