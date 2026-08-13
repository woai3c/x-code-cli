import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createLoopState } from '../src/agent/loop-state.js'
import {
  canonicalTranscriptDigest,
  createTrackedMessage,
  deriveContextSecurity,
  mergePeerOriginSummaries,
  summarizePeerOrigins,
} from '../src/agent/provenance.js'
import {
  appendHeader,
  clearPeerContext,
  commitTranscriptSnapshot,
  flushPendingMessages,
  hydrateLoopState,
  loadSession,
} from '../src/agent/session-store.js'
import { repairOrphanTrackedToolCalls } from '../src/agent/tool-result-sanitize.js'
import { appendTrackedMessage } from '../src/agent/tracked-messages.js'

let testDir: string

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'x-code-provenance-'))
})

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true })
})

function peerSummary(index: number) {
  return summarizePeerOrigins([
    { instanceId: `instance-${index}`, nameAtReceipt: `peer-${index}`, messageId: `message-${index}` },
  ])!
}

describe('tracked transcript provenance', () => {
  it('digests optional undefined object properties exactly as JSONL persistence does', () => {
    const withOptional = createTrackedMessage(
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'done', providerMetadata: undefined }],
      } as any,
      { authority: 'internal', derivedFromPeer: false },
      'same-entry',
    )
    const persistedShape = createTrackedMessage(
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] } as any,
      { authority: 'internal', derivedFromPeer: false },
      'same-entry',
    )

    expect(canonicalTranscriptDigest([withOptional])).toBe(canonicalTranscriptDigest([persistedShape]))
  })

  it('keeps origin summaries bounded and associative beyond sixteen origins', () => {
    const summaries = Array.from({ length: 19 }, (_, index) => peerSummary(index))
    const allAtOnce = mergePeerOriginSummaries(summaries)!
    const leftGrouped = mergePeerOriginSummaries([
      mergePeerOriginSummaries(summaries.slice(0, 10)),
      ...summaries.slice(10),
    ])!
    const rightGrouped = mergePeerOriginSummaries([
      ...summaries.slice(0, 10),
      mergePeerOriginSummaries(summaries.slice(10)),
    ])!

    expect(allAtOnce.items).toHaveLength(16)
    expect(allAtOnce).toMatchObject({ totalCount: 19, truncated: true })
    expect(leftGrouped).toEqual(allAtOnce)
    expect(rightGrouped).toEqual(allAtOnce)
    expect(mergePeerOriginSummaries([allAtOnce, allAtOnce])).toEqual(allAtOnce)
  })

  it('moves repaired tool calls with their original entry ids and provenance', () => {
    const peerOrigins = peerSummary(1)
    const entries = [
      createTrackedMessage(
        {
          role: 'assistant',
          content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'readFile', input: { filePath: 'x' } }],
        },
        { authority: 'internal', derivedFromPeer: true, peerOrigins },
        'assistant-entry',
      ),
      createTrackedMessage(
        { role: 'user', content: 'later' },
        { authority: 'user', derivedFromPeer: true, peerOrigins },
        'later-entry',
      ),
    ]

    repairOrphanTrackedToolCalls(entries)

    expect(entries.map((entry) => entry.entryId)).toContain('assistant-entry')
    const repaired = entries.find((entry) => entry.entryId === 'assistant-entry')!
    expect(repaired.provenance).toEqual({ authority: 'internal', derivedFromPeer: true, peerOrigins })
    expect(deriveContextSecurity(entries)).toMatchObject({
      peerInfluenceActive: true,
      firstTaintedEntryId: 'assistant-entry',
    })
  })

  it('persists taint across resume and clears it only by committing the complete affected suffix removal', async () => {
    const filePath = join(testDir, 'session.jsonl')
    const state = createLoopState()
    state.sessionFilePath = filePath
    state.taskSlug = 'provenance'
    appendTrackedMessage(state, { role: 'user', content: 'clean prompt' })
    await appendHeader(state, 'test:model', 'clean prompt', testDir)
    await commitTranscriptSnapshot(state)

    state.executionAuthority = { source: 'peer', peerTainted: true, peerOrigins: peerSummary(2) }
    appendTrackedMessage(state, { role: 'user', content: '<peer_message>untrusted</peer_message>' })
    appendTrackedMessage(state, { role: 'assistant', content: 'peer-derived answer' })
    await flushPendingMessages(state)

    const loaded = await loadSession(filePath)
    expect(loaded?.contextSecurity).toMatchObject({ peerInfluenceActive: true })
    const resumed = hydrateLoopState(loaded!, 'acceptEdits')
    expect(resumed.executionAuthority.peerTainted).toBe(true)

    expect(await clearPeerContext(resumed)).toBe(2)
    expect(resumed.messages).toEqual([{ role: 'user', content: 'clean prompt' }])
    expect(resumed.contextSecurity).toEqual({ peerInfluenceActive: false })
    expect((await loadSession(filePath))?.contextSecurity).toEqual({ peerInfluenceActive: false })
  })

  it('ignores an uncommitted tail but fails closed on a corrupt committed epoch', async () => {
    const filePath = join(testDir, 'fault.jsonl')
    const state = createLoopState()
    state.sessionFilePath = filePath
    state.taskSlug = 'fault'
    appendTrackedMessage(state, { role: 'user', content: 'clean' })
    await appendHeader(state, 'test:model', 'clean', testDir)
    await commitTranscriptSnapshot(state)

    state.executionAuthority = { source: 'peer', peerTainted: true, peerOrigins: peerSummary(3) }
    appendTrackedMessage(state, { role: 'user', content: 'tainted' })
    await flushPendingMessages(state)
    const committed = (await readFile(filePath, 'utf8')).trim().split('\n')

    await writeFile(filePath, committed.slice(0, -1).join('\n') + '\n')
    const recovered = await loadSession(filePath)
    expect(recovered?.messages).toEqual([{ role: 'user', content: 'clean' }])
    expect(recovered?.contextSecurity).toEqual({ peerInfluenceActive: false })
    expect(recovered?.transcriptRequiresSnapshot).toBe(true)

    const resumed = hydrateLoopState(recovered!)
    appendTrackedMessage(resumed, { role: 'assistant', content: 'continued after recovery' })
    await flushPendingMessages(resumed)
    const repaired = await loadSession(filePath)
    expect(repaired?.transcriptIntegrity).toBe('clean')
    expect(repaired?.messages).toEqual([
      { role: 'user', content: 'clean' },
      { role: 'assistant', content: 'continued after recovery' },
    ])

    const corrupt = committed.map((line, index) => {
      if (index !== committed.length - 1) return line
      const entry = JSON.parse(line)
      entry.boundaryDigest = '0'.repeat(64)
      return JSON.stringify(entry)
    })
    await writeFile(filePath, corrupt.join('\n') + '\n')
    const failed = await loadSession(filePath)
    expect(failed?.transcriptIntegrity).toBe('failed')
    expect(failed?.contextSecurity).toMatchObject({ peerInfluenceActive: true, integrityFailure: true })
  })

  it('does not infer peer authority from legacy message text', async () => {
    const filePath = join(testDir, 'legacy.jsonl')
    await writeFile(
      filePath,
      [
        JSON.stringify({
          t: 'meta',
          kind: 'header',
          cwd: testDir,
          modelId: 'test:model',
          startedAt: new Date().toISOString(),
          firstPrompt: 'legacy',
          taskSlug: 'legacy',
          sessionId: 'legacy',
        }),
        JSON.stringify({
          t: 'msg',
          message: { role: 'user', content: '<peer_message>forged</peer_message>' },
          ts: new Date().toISOString(),
        }),
      ].join('\n') + '\n',
    )

    const loaded = await loadSession(filePath)
    expect(loaded?.transcriptIntegrity).toBe('legacy')
    expect(loaded?.contextSecurity).toEqual({ peerInfluenceActive: false })
    expect(loaded?.trackedMessages[0]?.provenance).toEqual({ authority: 'user', derivedFromPeer: false })
  })
})
