import { tool } from 'ai'

import { z } from 'zod'

import { MAX_MESSAGE_BYTES } from './protocol.js'

export const listAgentsTool = tool({
  description: 'List other live X-Code sessions that can receive a message.',
  inputSchema: z.object({}),
})

export const sendMessageTool = tool({
  description: 'Send plain text to another live X-Code session.',
  inputSchema: z.object({
    to: z.string().min(1).max(128),
    message: z
      .string()
      .min(1)
      .refine((value) => Buffer.byteLength(value, 'utf8') <= MAX_MESSAGE_BYTES),
    summary: z.string().min(1).max(200).optional(),
    messageId: z.string().uuid().optional().describe('Reuse only after PEER_DELIVERY_UNKNOWN.'),
  }),
})
