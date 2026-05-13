// Assertion helpers exposed via ctx.expect.
import fs from 'node:fs/promises'
import path from 'node:path'

import { ScenarioAssertionError } from './types.js'
import type { RunResult, ScenarioExpect, ToolCall } from './types.js'

function valueMatches(actual: unknown, matcher: unknown | RegExp | ((v: unknown) => boolean)): boolean {
  if (matcher instanceof RegExp) {
    if (typeof actual !== 'string') return false
    return matcher.test(actual)
  }
  if (typeof matcher === 'function') {
    return Boolean((matcher as (v: unknown) => boolean)(actual))
  }
  if (matcher && typeof matcher === 'object' && actual && typeof actual === 'object') {
    for (const [k, v] of Object.entries(matcher as Record<string, unknown>)) {
      if (!valueMatches((actual as Record<string, unknown>)[k], v)) return false
    }
    return true
  }
  return actual === matcher
}

function fmtInput(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input).slice(0, 200)
  } catch {
    return String(input)
  }
}

export function makeExpect(tmpDir: string): ScenarioExpect {
  return {
    toolCalled(result: RunResult, toolName: string, inputMatcher) {
      const candidates = result.toolCalls.filter((tc) => tc.toolName === toolName)
      if (candidates.length === 0) {
        const all = result.toolCalls.map((tc) => tc.toolName).join(', ') || '(none)'
        throw new ScenarioAssertionError(`expected tool '${toolName}' to be called — got: [${all}]`)
      }
      if (!inputMatcher) return candidates[0]!
      for (const c of candidates) {
        if (valueMatches(c.input, inputMatcher)) return c
      }
      const dump = candidates.map((c) => `\n    ${fmtInput(c.input)}`).join('')
      throw new ScenarioAssertionError(
        `tool '${toolName}' was called but no invocation matched ${JSON.stringify(inputMatcher)}; saw:${dump}`,
      )
    },

    toolNotCalled(result: RunResult, toolName: string) {
      const hit = result.toolCalls.find((tc) => tc.toolName === toolName)
      if (hit) {
        throw new ScenarioAssertionError(`expected '${toolName}' NOT to be called; got: ${fmtInput(hit.input)}`)
      }
    },

    assistantMentions(result: RunResult, needle: string | RegExp) {
      const text = result.assistantText
      const ok = needle instanceof RegExp ? needle.test(text) : text.includes(needle)
      if (!ok) {
        const head = text.slice(0, 400)
        throw new ScenarioAssertionError(`assistant text did not match ${needle}; got (first 400 chars):\n    ${head}`)
      }
    },

    exitCode(result: RunResult, code: number) {
      if (result.exitCode !== code) {
        throw new ScenarioAssertionError(
          `expected exit code ${code}, got ${result.exitCode}; stderr tail:\n    ${result.stderr.slice(-400)}`,
        )
      }
    },

    async fileExists(relPath: string) {
      const abs = path.join(tmpDir, relPath)
      try {
        await fs.access(abs)
      } catch {
        throw new ScenarioAssertionError(`expected file '${relPath}' to exist (looked at ${abs})`)
      }
    },

    async fileContent(relPath: string, matcher: string | RegExp) {
      const abs = path.join(tmpDir, relPath)
      let content: string
      try {
        content = await fs.readFile(abs, 'utf-8')
      } catch {
        throw new ScenarioAssertionError(`expected file '${relPath}' to exist (looked at ${abs})`)
      }
      const ok = matcher instanceof RegExp ? matcher.test(content) : content.includes(matcher)
      if (!ok) {
        throw new ScenarioAssertionError(
          `file '${relPath}' content did not match ${matcher}; got:\n    ${content.slice(0, 400)}`,
        )
      }
    },

    noToolErrors(result: RunResult) {
      const errs = result.toolCalls.filter((tc) => tc.isError)
      if (errs.length > 0) {
        const dump = errs.map((tc) => `  - ${tc.toolName}: ${(tc.resultText ?? '').slice(0, 200)}`).join('\n')
        throw new ScenarioAssertionError(`expected no tool errors, got:\n${dump}`)
      }
    },

    truthy(condition: unknown, message: string) {
      if (!condition) throw new ScenarioAssertionError(message)
    },
  } satisfies ScenarioExpect & {
    toolCalled: (result: RunResult, name: string, matcher?: Record<string, unknown>) => ToolCall
  }
}
