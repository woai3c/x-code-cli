import { createLoopState } from '../src/agent/loop-state.js'
import {
  addMemoryRecallAttachment,
  addMemoryRecallTombstone,
  applyMemoryRecallAttachments,
} from '../src/knowledge/memory-recall-state.js'
import type { MemoryRecallAttachment } from '../src/knowledge/memory-types.js'

function attachment(): MemoryRecallAttachment {
  return {
    attachmentId: 'memory-1',
    anchorMessageIndex: 0,
    placement: 'before-user',
    estimatedTokens: 20,
    topics: [
      {
        topicId: 'profile',
        topicHash: 'topic-hash',
        factIds: ['user.language'],
        factHashes: { 'user.language': 'fact-hash' },
        path: 'topics/profile.md',
        renderedContent: 'Reply in Chinese.',
      },
    ],
  }
}

describe('memory recall attachment state', () => {
  it('injects low-authority context into a request copy without polluting transcript', () => {
    const state = createLoopState()
    state.messages.push({ role: 'user', content: 'How should you reply?' })
    expect(addMemoryRecallAttachment(state, attachment())).toBe(true)
    expect(addMemoryRecallAttachment(state, attachment())).toBe(false)

    const request = applyMemoryRecallAttachments(state.messages, state)
    expect(String(request[0]?.content)).toContain('x-code-memory-context')
    expect(state.messages[0]?.content).toBe('How should you reply?')
  })

  it('tombstones changed facts so stale attachments are never injected', () => {
    const state = createLoopState()
    state.messages.push({ role: 'user', content: 'Question' })
    addMemoryRecallAttachment(state, attachment())
    addMemoryRecallTombstone(state, { generation: 2, factIds: ['user.language'] })
    expect(applyMemoryRecallAttachments(state.messages, state)[0]?.content).toBe('Question')
  })
})
