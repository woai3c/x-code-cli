import {
  clearOpenAIChatGPTCredentials,
  getOpenAIAuthStatus,
  loginOpenAIChatGPTWithBrowser,
  loginOpenAIChatGPTWithDevice,
  readOpenAIChatGPTCredentials,
  revokeOpenAIChatGPTCredentials,
  withOpenAIChatGPTCredentialLock,
  writeOpenAIChatGPTCredentials,
} from '@x-code-cli/core'

import { VERSION } from './version.js'

function accountSummary(value: string | undefined): string | undefined {
  if (!value) return undefined
  if (value.includes('@')) {
    const [local, domain] = value.split('@', 2)
    if (!local || !domain) return '***'
    return `${local.slice(0, 2)}***@${domain}`
  }
  if (value.length <= 6) return `${value.slice(0, 1)}***`
  return `${value.slice(0, 4)}…${value.slice(-2)}`
}

function printStatus(): void {
  const status = getOpenAIAuthStatus()
  if (status.mode === 'none') {
    console.log('OpenAI authentication: none')
    console.log('Run `xc login` for ChatGPT subscription access, or set OPENAI_API_KEY for Platform access.')
    return
  }
  if (status.mode === 'api-key') {
    console.log('OpenAI authentication: API key (OPENAI_API_KEY)')
    return
  }

  console.log('OpenAI authentication: ChatGPT subscription')
  const email = accountSummary(status.email)
  if (email) console.log(`Account: ${email}`)
  const account = accountSummary(status.accountId)
  if (account) console.log(`Workspace: ${account}`)
  if (status.planType) console.log(`Plan: ${status.planType}`)
  if (status.expiresAt)
    console.log(`Access token expires: ${new Date(status.expiresAt).toISOString()} (auto-refresh enabled)`)
  if (status.apiKeyConfigured) console.log('OPENAI_API_KEY: configured but inactive while ChatGPT is signed in')
  if (status.credentialError) console.log(`Credential error: ${status.credentialError}`)
}

async function runLogin(deviceAuth: boolean, signal: AbortSignal): Promise<void> {
  const userAgent = `x-code-cli/${VERSION}`
  const credentials = deviceAuth
    ? await loginOpenAIChatGPTWithDevice({
        signal,
        userAgent,
        onUserCode: (url, code) => {
          console.log(`Open ${url}`)
          console.log(`Enter code: ${code}`)
        },
      })
    : await loginOpenAIChatGPTWithBrowser({
        signal,
        userAgent,
        onAuthorizationUrl: (url) => {
          console.log('Complete ChatGPT sign-in in your browser:')
          console.log(url)
        },
      })
  await withOpenAIChatGPTCredentialLock(() => writeOpenAIChatGPTCredentials(credentials), signal)
  console.log('ChatGPT login successful. OpenAI requests will use your ChatGPT subscription.')
  if (process.env.OPENAI_API_KEY)
    console.log('OPENAI_API_KEY is now inactive for the OpenAI provider until `xc logout`.')
}

async function runLogout(signal: AbortSignal): Promise<void> {
  const result = await withOpenAIChatGPTCredentialLock(async () => {
    let credentials
    try {
      credentials = await readOpenAIChatGPTCredentials()
    } catch {
      // A missing or malformed credential still needs to be removed locally.
    }
    let revokeFailed = false
    if (credentials) {
      try {
        await revokeOpenAIChatGPTCredentials(credentials, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
          userAgent: `x-code-cli/${VERSION}`,
        })
      } catch {
        revokeFailed = true
      }
    }
    return { removed: await clearOpenAIChatGPTCredentials(), revokeFailed }
  }, signal)
  if (!result.removed) {
    console.log('ChatGPT is already signed out.')
    return
  }
  console.log('ChatGPT logout complete.')
  if (result.revokeFailed) console.log('The remote revoke request failed, but local credentials were removed.')
  if (process.env.OPENAI_API_KEY) console.log('OPENAI_API_KEY is now active for the OpenAI provider.')
}

export async function runAuthCli(args: string[]): Promise<number> {
  const controller = new AbortController()
  const onInterrupt = () => controller.abort()
  process.once('SIGINT', onInterrupt)
  try {
    if (args[0] === 'login' && args[1] === 'status' && args.length === 2) {
      printStatus()
      return 0
    }
    if (args[0] === 'login') {
      const flags = args.slice(1)
      if (flags.some((flag) => flag !== '--device-auth')) {
        console.error('Usage: xc login [--device-auth] | xc login status')
        return 2
      }
      await runLogin(flags.includes('--device-auth'), controller.signal)
      return 0
    }
    if (args[0] === 'logout' && args.length === 1) {
      await runLogout(controller.signal)
      return 0
    }
    console.error('Usage: xc login [--device-auth] | xc login status | xc logout')
    return 2
  } catch (err) {
    if (controller.signal.aborted) {
      console.error('ChatGPT authentication cancelled.')
      return 130
    }
    console.error(err instanceof Error ? err.message : String(err))
    return 1
  } finally {
    process.removeListener('SIGINT', onInterrupt)
  }
}
