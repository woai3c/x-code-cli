import { zodToJsonSchema } from 'zod-to-json-schema'

import { estimateTextTokenCount } from './context-window.js'

/** Estimate the model-facing wire size of one function tool. Shared by the
 *  direct-tool budget and /usage so policy and observability use one number. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function estimateToolDefinitionTokens(name: string, def: any): number {
  const payload: Record<string, unknown> = { name }
  if (typeof def?.description === 'string') payload.description = def.description
  const schema = def?.inputSchema
  if (schema) {
    try {
      const rawJsonSchema =
        typeof schema === 'object' && schema !== null ? (schema as { jsonSchema?: unknown }).jsonSchema : undefined
      if (rawJsonSchema && typeof rawJsonSchema === 'object') {
        payload.parameters = rawJsonSchema
      } else {
        payload.parameters = zodToJsonSchema(schema)
      }
    } catch {
      try {
        payload.parameters = JSON.stringify(schema)
      } catch {
        // Unknown circular schema: description + name still provide a lower bound.
      }
    }
  }
  return estimateTextTokenCount(JSON.stringify(payload))
}

export function estimateToolSetTokens(tools: Record<string, unknown>): number {
  return Object.entries(tools).reduce((sum, [name, def]) => sum + estimateToolDefinitionTokens(name, def), 0)
}
