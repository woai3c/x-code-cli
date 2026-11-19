import type { JSONSchema7 } from '@ai-sdk/provider'
import { jsonSchema } from 'ai'

import type { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'

/** Advertise `publicSchema` on the wire while validating tool inputs against
 *  `runtimeSchema` so hidden compatibility fields/shapes survive AI SDK
 *  tool-call parsing without costing prompt tokens or widening model schemas. */
export function createCompatibleInputSchema<T extends z.ZodTypeAny>(publicSchema: z.ZodTypeAny, runtimeSchema: T) {
  const wireSchema = zodToJsonSchema(publicSchema, { $refStrategy: 'none' }) as JSONSchema7
  return jsonSchema<z.output<T>>(wireSchema, {
    validate: (value) => {
      const parsed = runtimeSchema.safeParse(value)
      return parsed.success ? { success: true, value: parsed.data } : { success: false, error: parsed.error }
    },
  })
}
