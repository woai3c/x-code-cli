import type { AuthorityApproval, AuthorityApprovalPreview } from '@x-code-cli/core'

export function authorityApproval(
  preview: AuthorityApprovalPreview,
  decision: 'allow-once' | 'deny',
): AuthorityApproval {
  return {
    decision,
    authorityHash: preview.authorityHash,
    canonicalCallSha256: preview.canonicalCallSha256,
    ...(preview.outboundPayload ? { canonicalPayloadSha256: preview.outboundPayload.sha256 } : {}),
  }
}
