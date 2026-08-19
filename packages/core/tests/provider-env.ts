// Shared provider env-var list for tests that must scrub the developer's
// real shell environment before asserting "no providers configured"
// behavior. Derived from the catalog so adding a provider needs no test
// edit; the OPENAI_COMPATIBLE_* pair is read by getAvailableProviders.
import { PROVIDERS } from '../src/providers/catalog.js'

export const PROVIDER_ENV_VARS: readonly string[] = [
  ...PROVIDERS.map((p) => p.envKey),
  'OPENAI_COMPATIBLE_API_KEY',
  'OPENAI_COMPATIBLE_BASE_URL',
]
