import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { EvidenceKind, MemoryStatus, MemoryType } from '../src/knowledge/memory-types.js'

export async function makeMemoryRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'x-code-memory-v2-'))
}

export function topicMarkdown(input: {
  id: string
  type?: MemoryType
  description?: string
  summary?: string
  aliases?: string[]
  keywords?: string[]
  appliesTo?: string[]
  related?: string[]
  pinned?: boolean
  facts?: Array<{
    id: string
    content: string
    observedAt?: string
    evidence?: EvidenceKind
    status?: MemoryStatus
  }>
  manual?: string
}): string {
  const facts = input.facts ?? []
  const list = (key: string, values: string[]) =>
    values.length ? `${key}:\n${values.map((value) => `  - ${value}`).join('\n')}` : `${key}: []`
  return `---
id: ${input.id}
type: ${input.type ?? 'project'}
description: ${input.description ?? `Memory for ${input.id}`}
summary: ${input.summary ?? ''}
created_at: 2026-08-01T00:00:00.000Z
updated_at: 2026-08-02T00:00:00.000Z
status: ${facts.some((fact) => (fact.status ?? 'active') === 'active') ? 'active' : 'stale'}
${list('keywords', input.keywords ?? [])}
${list('aliases', input.aliases ?? [])}
${list('applies_to', input.appliesTo ?? [])}
${list('related', input.related ?? [])}
pinned: ${input.pinned ?? false}
---

# ${input.id}

${input.manual ?? ''}

## Facts

${facts
  .map(
    (fact) => `<!-- x-memory: ${JSON.stringify({
      id: fact.id,
      observedAt: fact.observedAt ?? '2026-08-02T00:00:00.000Z',
      evidence: fact.evidence ?? 'explicit',
      status: fact.status ?? 'active',
    })} -->

${fact.content}`,
  )
  .join('\n\n')}
`
}

export async function writeTopic(root: string, markdown: string, id: string): Promise<void> {
  const dir = path.join(root, 'topics')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${id}.md`), markdown, 'utf-8')
}
