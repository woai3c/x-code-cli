// @x-code/core — Plan Mode logic

import fs from 'node:fs/promises'
import path from 'node:path'

const PLANS_DIR = '.x-code/plans'

/** Generate a plan ID based on timestamp */
export function generatePlanId(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
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
