// @x-code/core — Startup project scan (reads config files to inject basic context)

import fs from 'node:fs/promises'
import path from 'node:path'

import { getAutoMemory } from './auto-memory.js'

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function readJsonSafe(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8')
    return JSON.parse(content) as Record<string, unknown>
  } catch {
    return null
  }
}

/** Scan project root and populate auto memory with basic facts */
export async function scanProject(projectRoot: string): Promise<void> {
  const memory = getAutoMemory('project')

  // Detect package manager from lock files
  if (await fileExists(path.join(projectRoot, 'pnpm-lock.yaml'))) {
    memory.add({ key: 'package-manager', fact: 'pnpm', category: 'tech-stack', date: today() })
  } else if (await fileExists(path.join(projectRoot, 'yarn.lock'))) {
    memory.add({ key: 'package-manager', fact: 'yarn', category: 'tech-stack', date: today() })
  } else if (await fileExists(path.join(projectRoot, 'package-lock.json'))) {
    memory.add({ key: 'package-manager', fact: 'npm', category: 'tech-stack', date: today() })
  }

  // Read package.json
  const pkg = await readJsonSafe(path.join(projectRoot, 'package.json'))
  if (pkg) {
    const scripts = pkg.scripts as Record<string, string> | undefined
    if (scripts?.test) {
      memory.add({ key: 'test-command', fact: scripts.test, category: 'commands', date: today() })
    }
    if (scripts?.build) {
      memory.add({ key: 'build-command', fact: scripts.build, category: 'commands', date: today() })
    }
    if (scripts?.lint) {
      memory.add({ key: 'lint-command', fact: scripts.lint, category: 'commands', date: today() })
    }

    const deps: Record<string, string> = {
      ...(pkg.dependencies as Record<string, string> | undefined),
      ...(pkg.devDependencies as Record<string, string> | undefined),
    }
    if (deps.react) memory.add({ key: 'ui-framework', fact: `React ${deps.react}`, category: 'tech-stack', date: today() })
    if (deps.vitest) memory.add({ key: 'test-framework', fact: 'Vitest', category: 'tech-stack', date: today() })
    if (deps.typescript) memory.add({ key: 'language', fact: `TypeScript ${deps.typescript}`, category: 'tech-stack', date: today() })
    if (deps.ink) memory.add({ key: 'tui-framework', fact: `Ink ${deps.ink}`, category: 'tech-stack', date: today() })
  }

  // Read tsconfig for TS settings
  const tsconfig = await readJsonSafe(path.join(projectRoot, 'tsconfig.json'))
  if (tsconfig) {
    const compilerOptions = tsconfig.compilerOptions as Record<string, unknown> | undefined
    if (compilerOptions?.strict) {
      memory.add({ key: 'ts-strict-mode', fact: 'enabled', category: 'conventions', date: today() })
    }
    if (compilerOptions?.module?.toString().toLowerCase().includes('nodenext')) {
      memory.add({ key: 'module-system', fact: 'ESM (NodeNext)', category: 'conventions', date: today() })
    }
  }
}
