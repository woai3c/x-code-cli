// @x-code/core — Knowledge loader (layered loading + 4 rule loading modes)

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { RuleFile, RuleFrontmatter } from '../types/index.js'
import { getAutoMemory } from './auto-memory.js'

const XCODE_DIR = '.x-code'
const GLOBAL_DIR = path.join(os.homedir(), '.xcode')

/** Read a file safely, return empty string on error */
async function readFileSafe(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf-8')
  } catch {
    return ''
  }
}

/** Parse frontmatter from a markdown rule file */
function parseFrontmatter(content: string): { frontmatter: RuleFrontmatter; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) return { frontmatter: {}, body: content }

  const frontmatter: RuleFrontmatter = {}
  const yamlLines = match[1].split('\n')
  for (const line of yamlLines) {
    const kvMatch = line.match(/^(\w+):\s*(.+)$/)
    if (!kvMatch) continue
    const [, key, value] = kvMatch
    if (key === 'alwaysApply') frontmatter.alwaysApply = value.trim() === 'true'
    else if (key === 'description') frontmatter.description = value.trim().replace(/^"(.*)"$/, '$1')
    else if (key === 'paths') {
      // Parse YAML array: ["glob1", "glob2"]
      const arrayMatch = value.match(/\[(.+)\]/)
      if (arrayMatch) {
        frontmatter.paths = arrayMatch[1].split(',').map((p) => p.trim().replace(/^"(.*)"$/, '$1'))
      }
    }
  }

  return { frontmatter, body: match[2] }
}

/** Load all rule files from .x-code/rules/ */
async function loadRuleFiles(): Promise<RuleFile[]> {
  const rulesDir = path.join(process.cwd(), XCODE_DIR, 'rules')
  try {
    const files = await fs.readdir(rulesDir)
    const rules: RuleFile[] = []
    for (const file of files) {
      if (!file.endsWith('.md')) continue
      const content = await readFileSafe(path.join(rulesDir, file))
      const { frontmatter, body } = parseFrontmatter(content)
      rules.push({ filename: file.replace('.md', ''), frontmatter, content: body })
    }
    return rules
  } catch {
    return []
  }
}

/** Check if a file path matches any of the glob patterns (simple matching) */
function matchesPath(filePath: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    // Simple glob matching: ** matches any path segment, * matches within segment
    const regex = pattern
      .replace(/\*\*/g, '___DOUBLESTAR___')
      .replace(/\*/g, '[^/]*')
      .replace(/___DOUBLESTAR___/g, '.*')
    if (new RegExp(regex).test(filePath)) return true
  }
  return false
}

/** Build the full knowledge context for system prompt injection */
export async function buildKnowledgeContext(options?: {
  activeFilePaths?: string[]
  sessionContext?: string
}): Promise<string> {
  const sections: string[] = []

  // 1. Global preferences
  const globalKnowledge = await readFileSafe(path.join(GLOBAL_DIR, 'knowledge.md'))
  if (globalKnowledge) {
    sections.push('### Global Preferences\n' + globalKnowledge)
  }

  // 2. Global auto memory
  const globalMemory = getAutoMemory('global')
  const globalMemoryContent = globalMemory.getPromptContent()
  if (globalMemoryContent) {
    sections.push('### Global Auto Memory\n' + globalMemoryContent)
  }

  // 3. Project knowledge
  const projectKnowledge = await readFileSafe(path.join(process.cwd(), XCODE_DIR, 'knowledge.md'))
  if (projectKnowledge) {
    sections.push('### Project Knowledge\n' + projectKnowledge)
  }

  // 4. Project auto memory
  const projectMemory = getAutoMemory('project')
  const projectMemoryContent = projectMemory.getPromptContent()
  if (projectMemoryContent) {
    sections.push('### Project Auto Memory\n' + projectMemoryContent)
  }

  // 5. Local preferences
  const localPrefs = await readFileSafe(path.join(process.cwd(), XCODE_DIR, 'local', 'preferences.md'))
  if (localPrefs) {
    sections.push('### Local Preferences\n' + localPrefs)
  }

  // 6. Rules (4 loading modes)
  const rules = await loadRuleFiles()

  // Always rules
  for (const rule of rules) {
    if (rule.frontmatter.alwaysApply) {
      sections.push(`### Rule: ${rule.filename}\n${rule.content}`)
    }
  }

  // Path-match rules
  if (options?.activeFilePaths?.length) {
    for (const rule of rules) {
      if (rule.frontmatter.paths?.length) {
        const matched = options.activeFilePaths.some((fp) => matchesPath(fp, rule.frontmatter.paths!))
        if (matched) {
          sections.push(`### Rule: ${rule.filename}\n${rule.content}`)
        }
      }
    }
  }

  // Agent-requested rules: just list descriptions so model can request
  const requestableRules = rules.filter((r) => r.frontmatter.description && !r.frontmatter.alwaysApply)
  if (requestableRules.length > 0) {
    const list = requestableRules.map((r) => `- @${r.filename}: ${r.frontmatter.description}`).join('\n')
    sections.push(`### Available Rules (mention @name to load)\n${list}`)
  }

  // 7. Session context
  if (options?.sessionContext) {
    sections.push(options.sessionContext)
  }

  if (sections.length === 0) return ''
  return '## Project Knowledge\n\n' + sections.join('\n\n')
}

export { loadRuleFiles, matchesPath }
