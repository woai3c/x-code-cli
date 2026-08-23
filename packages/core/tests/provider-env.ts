// Shared provider env-var list for tests that must scrub the developer's
// real shell environment before asserting "no providers configured"
// behavior. Derived from the catalog so adding a provider needs no test
// edit; the OPENAI_COMPATIBLE_* pair is read by getAvailableProviders.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { resetOpenAIAuthContextForTesting } from '../src/auth/openai-chatgpt/auth-resolver.js'
import { PROVIDERS } from '../src/providers/catalog.js'
import { resetOpenAIChatGPTModelsForTesting } from '../src/providers/openai-chatgpt-models.js'

export const PROVIDER_ENV_VARS: readonly string[] = [
  ...PROVIDERS.map((p) => p.envKey),
  'OPENAI_COMPATIBLE_API_KEY',
  'OPENAI_COMPATIBLE_BASE_URL',
]

/** Keep provider-policy tests independent from a developer's real `xc login`. */
export function isolateOpenAIAuth(): () => void {
  const previousHome = process.env.X_CODE_HOME
  const isolatedHome = path.join(os.tmpdir(), `x-code-provider-auth-${crypto.randomUUID()}`)
  process.env.X_CODE_HOME = isolatedHome
  resetOpenAIAuthContextForTesting()
  resetOpenAIChatGPTModelsForTesting()
  return () => {
    resetOpenAIAuthContextForTesting()
    resetOpenAIChatGPTModelsForTesting()
    if (previousHome === undefined) delete process.env.X_CODE_HOME
    else process.env.X_CODE_HOME = previousHome
    fs.rmSync(isolatedHome, { recursive: true, force: true })
  }
}
