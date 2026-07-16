import fs from 'node:fs'
import path from 'node:path'

import { XCODE_DIR } from '../utils.js'
import type { AllowRule } from './session-store.js'

function ruleToString(rule: AllowRule): string {
  if (rule.type === 'tool') return `${rule.tool}:*`
  if (rule.type === 'prefix') return `${rule.tool}:${rule.pattern}:*`
  return `${rule.tool}:=${rule.pattern}`
}

function parseRuleString(value: string): AllowRule | null {
  const toolWide = value.match(/^([^:]+):\*$/)
  if (toolWide) return { tool: toolWide[1]!, pattern: '*', type: 'tool' }

  const prefix = value.match(/^([^:]+):(.+):\*$/)
  if (prefix) return { tool: prefix[1]!, pattern: prefix[2]!, type: 'prefix' }

  const exact = value.match(/^([^:]+):=(.+)$/)
  if (exact) return { tool: exact[1]!, pattern: exact[2]!, type: 'exact' }

  return null
}

function getPermissionsPath(cwd: string): string {
  return path.join(cwd, XCODE_DIR, 'local', 'permissions.json')
}

export function readPersistedRules(cwd: string): AllowRule[] {
  let raw: string
  try {
    raw = fs.readFileSync(getPermissionsPath(cwd), 'utf-8')
  } catch {
    return []
  }

  let data: { allow?: unknown }
  try {
    data = JSON.parse(raw) as { allow?: unknown }
  } catch {
    return []
  }
  if (!Array.isArray(data.allow)) return []

  return data.allow
    .filter((value): value is string => typeof value === 'string')
    .map(parseRuleString)
    .filter((rule): rule is AllowRule => rule !== null)
}

/**
 * Persist a new rule to `.x-code/local/permissions.json`.
 * Creates the file if it doesn't exist. Appends without duplicating.
 */
export function persistRule(cwd: string, rule: AllowRule): void {
  const filePath = getPermissionsPath(cwd)
  const ruleStr = ruleToString(rule)

  const data: { allow: string[] } = { allow: [] }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as { allow?: unknown }
    if (Array.isArray(parsed.allow)) {
      data.allow = parsed.allow.filter((value): value is string => typeof value === 'string')
    }
  } catch {
    // File doesn't exist or is malformed — start fresh.
  }

  if (data.allow.includes(ruleStr)) return
  data.allow.push(ruleStr)

  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const gitignorePath = path.join(dir, '.gitignore')
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, '*\n', 'utf-8')
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8')
}
