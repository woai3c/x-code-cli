import type { PeerMessagingConfig } from '../config/index.js'
import type { InboundDisposition } from './inbox-types.js'

export interface InboundPolicyInput {
  policy: PeerMessagingConfig['inbound']
  receiverPermissionClass: 'prompted' | 'bypass'
  senderPermissionClass: 'prompted' | 'bypass'
  dialogExpiryMs: number
  now?: number
}

export function decideInboundDisposition(input: InboundPolicyInput): InboundDisposition {
  if (input.policy === 'accept') return { kind: 'accept' }
  if (input.policy === 'refuse') return { kind: 'refuse', reason: 'policy' }
  if (input.policy === 'hold') {
    return {
      kind: 'hold',
      expiresAt: new Date((input.now ?? Date.now()) + input.dialogExpiryMs).toISOString(),
      policySource: 'explicit',
    }
  }
  if (input.receiverPermissionClass === input.senderPermissionClass) {
    return { kind: 'accept' }
  }
  return {
    kind: 'hold',
    expiresAt: new Date((input.now ?? Date.now()) + input.dialogExpiryMs).toISOString(),
    policySource: 'auto',
  }
}
