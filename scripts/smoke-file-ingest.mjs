// Offline smoke test for the file-ingest pipeline.
// Run:
//   node scripts/smoke-file-ingest.mjs
//
// Exercises buildUserContent against representative files without making
// any API calls — so you can verify the parts shape/size/types before
// paying for a real model roundtrip.
import fs from 'node:fs/promises'
import path from 'node:path'

import { buildUserContent, capabilitiesOf } from '../packages/core/dist/index.js'

const CASES = [
  { label: 'plain text (no refs)',      input: 'hello world',                                                   model: 'anthropic:claude-sonnet-4-6' },
  { label: 'markdown via @',            input: '看看 @D:\\res\\x-code-cli\\CHANGELOG.md',                         model: 'anthropic:claude-sonnet-4-6' },
  { label: 'markdown via @ on deepseek',input: '看看 @D:\\res\\x-code-cli\\CHANGELOG.md',                         model: 'deepseek:deepseek-v4-flash' },
  { label: 'missing file',              input: '@D:\\nope\\does-not-exist.md',                                   model: 'anthropic:claude-sonnet-4-6' },
  { label: 'json bare path',            input: 'summarize D:\\res\\x-code-cli\\package.json please',              model: 'openai:gpt-4.1' },
]

function summarizePart(part) {
  if (part.type === 'text') {
    const preview = part.text.slice(0, 120).replace(/\n/g, ' ')
    return `text[${part.text.length}ch]: ${preview}${part.text.length > 120 ? '…' : ''}`
  }
  if (part.type === 'image') {
    const len = part.image instanceof Uint8Array || Buffer.isBuffer(part.image) ? part.image.length : '?'
    return `image(${part.mediaType}, ${len}B)`
  }
  if (part.type === 'file') {
    const len = part.data instanceof Uint8Array || Buffer.isBuffer(part.data) ? part.data.length : '?'
    return `file(${part.mediaType}, ${len}B, ${part.filename ?? ''})`
  }
  return JSON.stringify(part).slice(0, 120)
}

async function run() {
  for (const { label, input, model } of CASES) {
    const caps = capabilitiesOf(model)
    console.log(`\n── ${label} · ${model} · caps=${JSON.stringify(caps)}`)
    console.log(`   input: ${input}`)
    const result = await buildUserContent(input, caps)
    if (typeof result === 'string') {
      console.log(`   => string (fast path): ${result}`)
    } else {
      console.log(`   => ${result.length} parts`)
      result.forEach((p, i) => console.log(`     [${i}] ${summarizePart(p)}`))
    }
  }
}

await run()
