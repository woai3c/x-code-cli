// Tests for permission system
import { describe, expect, it, vi } from 'vitest'

import { checkPermission, getPermissionLevel, isPathWithinProject } from '../src/permissions/index.js'
import {
  addSessionAllowRule,
  buildAllowRule,
  clearSessionRules,
  extractCommandPrefix,
  extractCompoundRules,
  sessionRulesMatch,
  suggestRuleLabel,
} from '../src/permissions/session-store.js'

describe('getPermissionLevel', () => {
  it('returns always-allow for read-only tools', () => {
    expect(getPermissionLevel('readFile', {})).toBe('always-allow')
    expect(getPermissionLevel('glob', {})).toBe('always-allow')
    expect(getPermissionLevel('grep', {})).toBe('always-allow')
    expect(getPermissionLevel('listDir', {})).toBe('always-allow')
    expect(getPermissionLevel('webSearch', {})).toBe('always-allow')
    expect(getPermissionLevel('webFetch', {})).toBe('always-allow')
  })

  it('returns ask for write tools', () => {
    expect(getPermissionLevel('edit', {})).toBe('ask')
    expect(getPermissionLevel('writeFile', {})).toBe('ask')
  })

  it('returns always-allow for read-only shell commands', () => {
    expect(getPermissionLevel('shell', { command: 'ls -la' })).toBe('always-allow')
    expect(getPermissionLevel('shell', { command: 'pwd' })).toBe('always-allow')
    expect(getPermissionLevel('shell', { command: 'cat file.txt' })).toBe('always-allow')
    expect(getPermissionLevel('shell', { command: 'git status' })).toBe('always-allow')
    expect(getPermissionLevel('shell', { command: 'git log --oneline' })).toBe('always-allow')
  })

  it('returns ask for write shell commands', () => {
    expect(getPermissionLevel('shell', { command: 'npm install' })).toBe('ask')
    expect(getPermissionLevel('shell', { command: 'mkdir test' })).toBe('ask')
    expect(getPermissionLevel('shell', { command: 'touch file.txt' })).toBe('ask')
  })

  it('returns deny for destructive shell commands', () => {
    expect(getPermissionLevel('shell', { command: 'rm -rf /' })).toBe('deny')
    expect(getPermissionLevel('shell', { command: 'sudo rm file' })).toBe('deny')
  })

  it('handles compound commands — all read-only', () => {
    expect(getPermissionLevel('shell', { command: 'ls -la | wc -l' })).toBe('always-allow')
    expect(getPermissionLevel('shell', { command: 'git status && git log' })).toBe('always-allow')
  })

  it('handles compound commands — mixed', () => {
    expect(getPermissionLevel('shell', { command: 'ls && npm install' })).toBe('ask')
  })

  it('handles compound commands — destructive', () => {
    expect(getPermissionLevel('shell', { command: 'ls && rm -rf /' })).toBe('deny')
  })

  // End-to-end against the three real complaints from the user:
  // PS pipelines that should never have prompted, and a `cd && build`
  // chain that should at least be derivable as a `npx tsc:*` rule.
  it('auto-allows real PowerShell read-only pipelines', () => {
    expect(
      getPermissionLevel('shell', {
        command:
          "cd D:\\res\\x-code-cli\\packages\\core\\src; Get-ChildItem -Recurse -Filter *.ts | Group-Object Directory | Sort-Object Name | Select-Object @{N='Directory';E={$_.Name}},Count",
      }),
    ).toBe('always-allow')
    expect(
      getPermissionLevel('shell', {
        command:
          "Get-ChildItem -Recurse -Filter *.ts -Path D:\\res\\x-code-cli\\packages\\core\\src | Group-Object Directory | Sort-Object Name | Select-Object @{Name='Directory';Expression={$_.Name}},Count",
      }),
    ).toBe('always-allow')
  })

  it('asks for `cd && build | head` but derives a stable prefix', () => {
    const cmd = 'cd d:\\isoform\\something\\wails-gui\\frontend && npx tsc --noEmit --pretty 2>&1 | head -40'
    expect(getPermissionLevel('shell', { command: cmd })).toBe('ask')
    // Importantly the rule we'd save is `npx tsc:*`, NOT `cd:*` or
    // exact-match — so subsequent `cd <other-dir> && npx tsc <other-args>`
    // invocations stop re-prompting.
    expect(suggestRuleLabel('shell', { command: cmd })).toBe('npx tsc:*')
  })

  it('auto-allows `ls X; if (Test-Path X) { Get-Content X }` end-to-end', () => {
    // The control-flow recognition feeds into the existing per-segment
    // isReadOnly check, so a `ls`-then-conditional-Get-Content compound
    // (the user's diagnostic command) drops to always-allow without
    // prompting.
    expect(
      getPermissionLevel('shell', {
        command:
          'ls -Force D:\\res\\x-code-cli\\.x-code\\local\\permissions.json 2>&1; if (Test-Path D:\\res\\x-code-cli\\.x-code\\local\\permissions.json) { Get-Content D:\\res\\x-code-cli\\.x-code\\local\\permissions.json }',
      }),
    ).toBe('always-allow')
  })
})

describe('checkPermission', () => {
  it('returns true for always-allow tools without asking', async () => {
    const askFn = vi.fn()
    const result = await checkPermission({ toolCallId: '1', toolName: 'readFile', input: {} }, false, askFn)
    expect(result).toBe(true)
    expect(askFn).not.toHaveBeenCalled()
  })

  it('prompts user for destructive shell commands (deny level)', async () => {
    const askFn = vi.fn().mockResolvedValue('yes')
    const result = await checkPermission(
      { toolCallId: '2', toolName: 'shell', input: { command: 'rm -rf /' } },
      false,
      askFn,
    )
    expect(result).toBe(true)
    expect(askFn).toHaveBeenCalled()
  })

  it('user can reject destructive shell commands', async () => {
    const askFn = vi.fn().mockResolvedValue('no')
    const result = await checkPermission(
      { toolCallId: '2b', toolName: 'shell', input: { command: 'rm -rf /' } },
      false,
      askFn,
    )
    expect(result).toBe(false)
    expect(askFn).toHaveBeenCalled()
  })

  it('trust mode auto-approves destructive shell commands', async () => {
    const askFn = vi.fn()
    const result = await checkPermission(
      { toolCallId: '2c', toolName: 'shell', input: { command: 'rm -rf /' } },
      true,
      askFn,
    )
    expect(result).toBe(true)
    expect(askFn).not.toHaveBeenCalled()
  })

  it('asks user for ask-level tools', async () => {
    const askFn = vi.fn().mockResolvedValue('yes')
    const result = await checkPermission({ toolCallId: '3', toolName: 'writeFile', input: {} }, false, askFn)
    expect(result).toBe(true)
    expect(askFn).toHaveBeenCalled()
  })

  it('auto-approves ask-level tools in trust mode', async () => {
    const askFn = vi.fn()
    const result = await checkPermission({ toolCallId: '4', toolName: 'writeFile', input: {} }, true, askFn)
    expect(result).toBe(true)
    expect(askFn).not.toHaveBeenCalled()
  })

  it('user can deny an ask-level tool', async () => {
    const askFn = vi.fn().mockResolvedValue('no')
    const result = await checkPermission({ toolCallId: '5', toolName: 'edit', input: {} }, false, askFn)
    expect(result).toBe(false)
    expect(askFn).toHaveBeenCalled()
  })

  it('acceptEdits auto-approves writes inside project dir', async () => {
    const askFn = vi.fn()
    const cwd = process.cwd()
    const result = await checkPermission(
      { toolCallId: '10', toolName: 'writeFile', input: { filePath: `${cwd}/src/foo.ts` } },
      false,
      askFn,
      'acceptEdits',
      cwd,
    )
    expect(result).toBe(true)
    expect(askFn).not.toHaveBeenCalled()
  })

  it('acceptEdits blocks writes outside project dir — falls to ask', async () => {
    const askFn = vi.fn().mockResolvedValue('no')
    const cwd = process.cwd()
    const result = await checkPermission(
      { toolCallId: '11', toolName: 'writeFile', input: { filePath: '/etc/passwd' } },
      false,
      askFn,
      'acceptEdits',
      cwd,
    )
    expect(result).toBe(false)
    expect(askFn).toHaveBeenCalled()
  })

  it('acceptEdits blocks writes to sensitive dotfiles — falls to ask', async () => {
    const askFn = vi.fn().mockResolvedValue('no')
    const cwd = process.cwd()
    const result = await checkPermission(
      { toolCallId: '12', toolName: 'edit', input: { filePath: `${cwd}/.env` } },
      false,
      askFn,
      'acceptEdits',
      cwd,
    )
    expect(result).toBe(false)
    expect(askFn).toHaveBeenCalled()
  })

  it('acceptEdits blocks writes to .git directory — falls to ask', async () => {
    const askFn = vi.fn().mockResolvedValue('no')
    const cwd = process.cwd()
    const result = await checkPermission(
      { toolCallId: '13', toolName: 'writeFile', input: { filePath: `${cwd}/.git/config` } },
      false,
      askFn,
      'acceptEdits',
      cwd,
    )
    expect(result).toBe(false)
    expect(askFn).toHaveBeenCalled()
  })

  it('acceptEdits blocks path traversal via ../ — falls to ask', async () => {
    const askFn = vi.fn().mockResolvedValue('no')
    const cwd = process.cwd()
    const result = await checkPermission(
      { toolCallId: '14', toolName: 'writeFile', input: { filePath: `${cwd}/../../etc/passwd` } },
      false,
      askFn,
      'acceptEdits',
      cwd,
    )
    expect(result).toBe(false)
    expect(askFn).toHaveBeenCalled()
  })
})

describe('extractCommandPrefix', () => {
  it('extracts two-token prefix for plain commands', () => {
    expect(extractCommandPrefix('git commit -m "fix"')).toBe('git commit')
    expect(extractCommandPrefix('pnpm run build')).toBe('pnpm run')
    expect(extractCommandPrefix('npm install lodash')).toBe('npm install')
  })

  it('strips whitelisted env-var prefixes', () => {
    expect(extractCommandPrefix('NODE_ENV=prod npm run dev')).toBe('npm run')
    expect(extractCommandPrefix('CI=1 DEBUG=foo npm test')).toBe('npm test')
    expect(extractCommandPrefix('LANG=en_US.UTF-8 NODE_ENV=prod git status')).toBe('git status')
  })

  it('returns null for unsafe env-var prefixes', () => {
    // Non-whitelisted assignment must block prefix extraction — otherwise
    // a once-approved `npm run dev` rule would also auto-approve
    // `BACKDOOR=1 npm run dev`. Forces exact-match fallback.
    expect(extractCommandPrefix('FOO=1 git status')).toBeNull()
    expect(extractCommandPrefix('PATH=/evil:$PATH npm run dev')).toBeNull()
    expect(extractCommandPrefix('NODE_OPTIONS="--require ./evil.js" npm test')).toBeNull()
    expect(extractCommandPrefix('http_proxy=http://attacker curl example.com')).toBeNull()
  })

  it('returns null for single-token or unprefixable commands', () => {
    expect(extractCommandPrefix('')).toBeNull()
    expect(extractCommandPrefix('ls')).toBeNull()
    expect(extractCommandPrefix('ls -la')).toBeNull()
  })

  it('skips global flags before the subcommand', () => {
    // Real failure case: `git -C /tmp commit -m fix` extracted nothing
    // because token[1] was `-C`, not a subcommand-shaped string.
    expect(extractCommandPrefix('git -C /tmp commit -m fix')).toBe('git commit')
    expect(extractCommandPrefix('git --no-pager log --oneline')).toBe('git log')
    expect(extractCommandPrefix('git -c user.name=foo commit')).toBe('git commit')
    expect(extractCommandPrefix('git --git-dir=/tmp/.git status')).toBe('git status')
    expect(extractCommandPrefix('docker -H tcp://host:2375 ps')).toBe('docker ps')
    expect(extractCommandPrefix('docker --context default ps -a')).toBe('docker ps')
    expect(extractCommandPrefix('kubectl -n production get pods')).toBe('kubectl get')
    expect(extractCommandPrefix('kubectl --context prod --namespace foo apply -f k.yaml')).toBe('kubectl apply')
    expect(extractCommandPrefix('cargo +nightly build --release')).toBe('cargo build')
    expect(extractCommandPrefix('cargo +stable test')).toBe('cargo test')
  })

  it('returns null for wrapper commands too broad to anchor a rule on', () => {
    // Approving `sudo ls` must NOT auto-approve `sudo <anything>`. Same
    // for env/time/xargs/bash -c. These force exact-match fallback.
    expect(extractCommandPrefix('sudo npm install')).toBeNull()
    expect(extractCommandPrefix('sudo apt-get update')).toBeNull()
    expect(extractCommandPrefix('bash -c "git push"')).toBeNull()
    expect(extractCommandPrefix('sh -c "rm foo"')).toBeNull()
    expect(extractCommandPrefix('env FOO=bar npm test')).toBeNull()
    expect(extractCommandPrefix('time npm run build')).toBeNull()
    expect(extractCommandPrefix('xargs git add')).toBeNull()
    expect(extractCommandPrefix('timeout 30 npm test')).toBeNull()
    expect(extractCommandPrefix('nohup node server.js')).toBeNull()
  })

  it('extracts cmdlet from quoted powershell -Command form', () => {
    expect(extractCommandPrefix('powershell -Command "Get-CimInstance Win32_LogicalDisk"')).toBe('Get-CimInstance')
    expect(extractCommandPrefix('powershell -c "Get-Process"')).toBe('Get-Process')
    expect(extractCommandPrefix('powershell.exe -Command "Get-Date"')).toBe('Get-Date')
  })

  it('handles powershell with leading flags before -Command', () => {
    // Real failure case from a.log: `-NoProfile` between launcher and `-Command`
    // hid the "don't ask again" option for every sub-agent shell call.
    expect(extractCommandPrefix('powershell -NoProfile -Command "Get-CimInstance Win32_LogicalDisk"')).toBe(
      'Get-CimInstance',
    )
    expect(extractCommandPrefix('powershell -ExecutionPolicy Bypass -Command "git status"')).toBe('git')
    expect(extractCommandPrefix('powershell -NoLogo -NonInteractive -Command "Get-Process"')).toBe('Get-Process')
    expect(extractCommandPrefix('powershell -NoProfile -ExecutionPolicy Bypass -c "Get-CimInstance"')).toBe(
      'Get-CimInstance',
    )
  })

  it('handles unquoted powershell command argument', () => {
    expect(extractCommandPrefix('powershell -Command Get-Date')).toBe('Get-Date')
    expect(extractCommandPrefix('powershell -NoProfile -Command Get-Process')).toBe('Get-Process')
  })

  it('handles powershell call-operator wrapping', () => {
    expect(extractCommandPrefix('powershell -Command "& { Get-Process }"')).toBe('Get-Process')
    expect(extractCommandPrefix('powershell -NoProfile -Command "& { Get-CimInstance Win32_LogicalDisk }"')).toBe(
      'Get-CimInstance',
    )
  })

  it('handles pwsh launcher', () => {
    expect(extractCommandPrefix('pwsh -Command "Get-Process"')).toBe('Get-Process')
    expect(extractCommandPrefix('pwsh.exe -NoProfile -Command "git status"')).toBe('git')
  })

  it('returns null for powershell -File (no derivable command name)', () => {
    expect(extractCommandPrefix('powershell -File ./script.ps1')).toBeNull()
    expect(extractCommandPrefix('powershell -NoProfile -File foo.ps1 arg1')).toBeNull()
  })

  it('returns null when powershell has only flags (no command)', () => {
    expect(extractCommandPrefix('powershell -NoProfile -ExecutionPolicy Bypass')).toBeNull()
  })

  // Verb-Noun cmdlet shape — the case the previous extractor missed.
  // `Get-ChildItem -Recurse …` was returning null because `-Recurse`
  // failed the lowercase SUBCOMMAND_RE, leaving the user with exact-match
  // only (so any `-Path` / `-Filter` change re-prompted forever).
  it('recognises bare PowerShell cmdlets as their own prefix', () => {
    expect(extractCommandPrefix('Get-ChildItem -Recurse -Filter *.ts')).toBe('Get-ChildItem')
    expect(extractCommandPrefix('Get-ChildItem -Recurse -Filter *.ts -Path D:\\res\\x-code-cli')).toBe('Get-ChildItem')
    expect(extractCommandPrefix('Sort-Object Name')).toBe('Sort-Object')
    expect(extractCommandPrefix('Invoke-WebRequest -Uri http://example.com')).toBe('Invoke-WebRequest')
    expect(extractCommandPrefix('Set-Content -Path foo.txt -Value bar')).toBe('Set-Content')
  })

  it('does not mis-classify Unix commands with dashes as cmdlets', () => {
    // `apt-get` looks vaguely cmdlet-shaped but the verb is lowercase.
    // Must still go through the POSIX path (no subcommand → null).
    expect(extractCommandPrefix('apt-get update')).toBe('apt-get update')
    expect(extractCommandPrefix('docker-compose up')).toBe('docker-compose up')
  })

  // Compound commands: prefix must agree across every non-read-only,
  // non-cd segment. Asymmetric agreement (`A && B` where B is different)
  // returns null so we don't accidentally let an `A:*` rule approve B.
  //
  // Note: all-readonly compounds (`cd D:\… ; Get-ChildItem | Sort-Object`)
  // don't appear here because evaluateShellPermission short-circuits them
  // to `always-allow` upstream — extractCommandPrefix is never called.
  // We only exercise the case where there's at least one non-readonly,
  // non-cd-like segment to anchor a rule on.
  it('strips leading cd/Set-Location segments before deriving the prefix', () => {
    expect(extractCommandPrefix('cd /tmp && npm test')).toBe('npm test')
    expect(extractCommandPrefix('Set-Location D:\\foo; Set-Content -Path x.txt -Value bar')).toBe('Set-Content')
    expect(extractCommandPrefix('pushd /tmp && cargo build && popd')).toBe('cargo build')
  })

  it('strips read-only pipeline tails before deriving the prefix', () => {
    // The user-reported example: only `npx tsc` is non-readonly; `cd`
    // and `head` are both read-only setup/display, so the rule we save
    // is `npx tsc:*` rather than `cd:*` or an over-specific exact match.
    expect(extractCommandPrefix('cd d:\\isoform\\foo && npx tsc --noEmit --pretty 2>&1 | head -40')).toBe('npx tsc')
    expect(extractCommandPrefix('npm run lint 2>&1 | tail -20')).toBe('npm run')
  })

  it('returns null when compound segments disagree on prefix', () => {
    // Security gate: `git commit:*` must NOT auto-approve a trailing
    // `git push`. Different segments → no shared prefix → exact-match.
    expect(extractCommandPrefix('git commit -m fix && git push')).toBeNull()
    // npm install + arbitrary curl: even though only `npm install` would
    // be derived under the old logic, the second segment is a distinct
    // command and must force exact-match.
    expect(extractCommandPrefix('npm install && curl example.com')).toBeNull()
  })

  it('still derives a prefix when only one non-readonly segment exists', () => {
    // Two readonly + one real command: anchor on the real command.
    expect(extractCommandPrefix('cd /tmp && pnpm run build | head -20')).toBe('pnpm run')
  })
})

// Direct tests for extractCompoundRules. The function is the engine
// behind suggestRuleLabel + buildAllowRule for compound shells, so a
// regression here surfaces in the user-visible "don't ask again" label
// and in what ends up in .x-code/local/permissions.json. Indirect
// coverage exists via the buildAllowRule tests below; spelling out the
// rule shape directly is worth the redundancy.
describe('extractCompoundRules', () => {
  const ruleShape = (r: { type: string; pattern: string }) => `${r.type}:${r.pattern}`

  it('single derivable command → one prefix rule', () => {
    const rules = extractCompoundRules('git commit -m fix')
    expect(rules?.map(ruleShape)).toEqual(['prefix:git commit'])
  })

  it('single Verb-Noun cmdlet → one prefix rule (cmdlet name on its own)', () => {
    // Must pick a cmdlet NOT in the readonly set, otherwise the segment
    // gets filtered out before reaching the prefix step (readonly
    // compounds short-circuit to always-allow upstream and don't need
    // rules). Set-Content writes a file, so it's a clean example.
    const rules = extractCompoundRules('Set-Content -Path foo.txt -Value bar')
    expect(rules?.map(ruleShape)).toEqual(['prefix:Set-Content'])
  })

  it('single command without a derivable prefix → one segment-exact rule', () => {
    const rules = extractCompoundRules('findstr /n "any" file.txt')
    expect(rules?.map(ruleShape)).toEqual(['exact:findstr /n "any" file.txt'])
  })

  it('compound with all distinct prefixes → one prefix rule per segment, order preserved', () => {
    const rules = extractCompoundRules('git commit -m a && git push origin main')
    expect(rules?.map(ruleShape)).toEqual(['prefix:git commit', 'prefix:git push'])
  })

  it('compound mixing prefix-able and not → prefix + segment-exact, order preserved', () => {
    const rules = extractCompoundRules('git commit -m a && curl evil.com')
    expect(rules?.map(ruleShape)).toEqual(['prefix:git commit', 'exact:curl evil.com'])
  })

  it('skips leading cd / Set-Location segments', () => {
    expect(extractCompoundRules('cd /tmp && npm test')?.map(ruleShape)).toEqual(['prefix:npm test'])
    expect(extractCompoundRules('Set-Location D:\\foo; Set-Content -Path x.txt -Value bar')?.map(ruleShape)).toEqual([
      'prefix:Set-Content',
    ])
    expect(extractCompoundRules('pushd /tmp && cargo build && popd')?.map(ruleShape)).toEqual(['prefix:cargo build'])
  })

  it('skips read-only segments (pipeline tails, leading setup)', () => {
    expect(extractCompoundRules('npm run lint 2>&1 | tail -20')?.map(ruleShape)).toEqual(['prefix:npm run'])
    expect(extractCompoundRules('cd /foo && pnpm run build | head -20')?.map(ruleShape)).toEqual(['prefix:pnpm run'])
  })

  it('deduplicates repeated prefixes across segments', () => {
    const rules = extractCompoundRules('git commit -m a && git commit --amend')
    expect(rules?.map(ruleShape)).toEqual(['prefix:git commit'])
  })

  it('deduplicates repeated segment-exact patterns across segments', () => {
    const rules = extractCompoundRules('curl evil.com && curl evil.com')
    expect(rules?.map(ruleShape)).toEqual(['exact:curl evil.com'])
  })

  it('keeps both forms separately when prefix-able and non-prefix-able overlap by name', () => {
    const rules = extractCompoundRules('git commit -m a && curl evil.com && git commit --amend && curl evil.com')
    expect(rules?.map(ruleShape)).toEqual(['prefix:git commit', 'exact:curl evil.com'])
  })

  it('handles the PowerShell launcher path by returning a single inner-cmdlet prefix', () => {
    // POWERSHELL_LAUNCHER_RE short-circuits to extractPowershellPrefix.
    // The whole `powershell -Command "..."` is one rule regardless of
    // what compound shape lives inside the quoted script.
    expect(extractCompoundRules('powershell -Command "Get-CimInstance Win32_LogicalDisk"')?.map(ruleShape)).toEqual([
      'prefix:Get-CimInstance',
    ])
    expect(extractCompoundRules('powershell -NoProfile -Command "& { Get-Process }"')?.map(ruleShape)).toEqual([
      'prefix:Get-Process',
    ])
    expect(extractCompoundRules('powershell -File ./script.ps1')).toBeNull()
  })

  it('returns null when a non-whitelisted env-var prefixes a segment', () => {
    // Same defence as extractSingleCommandPrefix: a `BACKDOOR=1 …`
    // prefix poisons the segment so we can't safely turn it into a
    // rule. Callers fall back to a single full-command exact via
    // buildAllowRule's stripSafeEnvVars branch.
    expect(extractCompoundRules('BACKDOOR=1 git status')).toBeNull()
    expect(extractCompoundRules('git commit -m a && PATH=/evil:$PATH something')).toBeNull()
  })

  it('strips whitelisted env-var prefixes inside a segment-exact rule', () => {
    // `NODE_ENV=prod` is in SAFE_ENV_VARS — it gets stripped before
    // being saved so the matcher key (which also strips) stays canonical.
    const rules = extractCompoundRules('NODE_ENV=prod findstr /v foo bar.txt')
    expect(rules?.map(ruleShape)).toEqual(['exact:findstr /v foo bar.txt'])
  })

  it('returns null for empty / whitespace-only input', () => {
    expect(extractCompoundRules('')).toBeNull()
    expect(extractCompoundRules('   ')).toBeNull()
  })

  it('returns null for all-readonly compounds (auto-allowed upstream)', () => {
    // `cd /tmp && ls -la` is all-readonly. Every segment gets filtered
    // out as readonly, leaving nothing to derive. evaluateShellPermission
    // short-circuits to always-allow before this branch is reached in
    // practice — the null return is the defensive "no rule needed"
    // signal.
    expect(extractCompoundRules('cd /tmp && ls -la')).toBeNull()
    expect(extractCompoundRules('Get-ChildItem -Recurse | Sort-Object Name | Select-Object Name')).toBeNull()
  })

  it('tags each rule with tool="shell"', () => {
    // The AllowRule shape stored on disk lives or dies by this — a
    // missing/wrong tool field means the matcher won't find the rule.
    const rules = extractCompoundRules('git commit -m a && curl evil.com')
    expect(rules?.every((r) => r.tool === 'shell')).toBe(true)
  })
})

describe('isPathWithinProject', () => {
  const cwd = process.cwd()

  it('returns true for paths inside the project', () => {
    expect(isPathWithinProject(`${cwd}/src/index.ts`, cwd)).toBe(true)
    expect(isPathWithinProject(`${cwd}/deep/nested/file.ts`, cwd)).toBe(true)
  })

  it('returns true when file path equals project dir', () => {
    expect(isPathWithinProject(cwd, cwd)).toBe(true)
  })

  it('returns false for paths outside the project', () => {
    expect(isPathWithinProject('/etc/passwd', cwd)).toBe(false)
    expect(isPathWithinProject('/tmp/evil.ts', cwd)).toBe(false)
  })

  it('returns false for traversal attacks', () => {
    expect(isPathWithinProject(`${cwd}/../../etc/passwd`, cwd)).toBe(false)
    expect(isPathWithinProject(`${cwd}/../secret`, cwd)).toBe(false)
  })
})

describe('suggestRuleLabel + buildAllowRule fallback for unrecognised shell commands', () => {
  it('offers an exact-match label for Windows commands with /flag second token', () => {
    // Real failure case: `findstr /n "any\b" "..." 2>nul` got Yes/No with
    // no "don't ask again" because `/n` failed the prefix regex. The
    // exact-match fallback gives the user a way out.
    const input = { command: 'findstr /n "any\\b" "D:\\res\\file.ts" 2>nul' }
    expect(suggestRuleLabel('shell', input)).toBe('this exact command')
    const built = buildAllowRule('shell', input)
    expect(built).not.toBeNull()
    expect(built!.persist).toBe(true)
    expect(built!.rules).toHaveLength(1)
    expect(built!.rules[0]!.type).toBe('exact')
    expect(built!.rules[0]!.pattern).toBe(input.command)
  })

  it('still prefers the prefix rule when one is derivable', () => {
    expect(suggestRuleLabel('shell', { command: 'git commit -m fix' })).toBe('git commit:*')
    const built = buildAllowRule('shell', { command: 'git commit -m fix' })
    expect(built!.rules).toHaveLength(1)
    expect(built!.rules[0]!.type).toBe('prefix')
    expect(built!.rules[0]!.pattern).toBe('git commit')
  })

  it('strips env-var prefixes before storing the exact-match pattern', () => {
    // `NODE_ENV=prod` is a SAFE env-var prefix; the matcher compares
    // against `stripEnvVars(cmd)`, so we must store the same stripped
    // shape in the rule pattern.
    const built = buildAllowRule('shell', { command: 'NODE_ENV=prod findstr /v foo bar.txt' })
    expect(built!.rules).toHaveLength(1)
    expect(built!.rules[0]!.type).toBe('exact')
    expect(built!.rules[0]!.pattern).toBe('findstr /v foo bar.txt')
  })

  it('returns null label/rule for empty shell command', () => {
    expect(suggestRuleLabel('shell', { command: '' })).toBe('this exact command')
    // buildAllowRule still bails on a fully empty command after stripping.
    expect(buildAllowRule('shell', { command: '' })).toBeNull()
  })

  it('keeps writeFile/edit on session-only tool-wide rules', () => {
    expect(suggestRuleLabel('writeFile', {})).toBe('all edits this session')
    const built = buildAllowRule('writeFile', {})
    expect(built!.rules).toHaveLength(1)
    expect(built!.rules[0]!.type).toBe('tool')
    expect(built!.persist).toBe(false)
  })

  it('saves a rule per distinct prefix for compound shell commands', () => {
    // The complaint case from the live CLI: `git commit && git push`
    // used to show "this exact command" because the two segments
    // disagree on prefix. We now surface BOTH prefixes in the label and
    // save BOTH rules with one click, so subsequent
    // `git commit -m foo && git push origin main` invocations stop
    // prompting.
    const cmd = 'git commit && git push'
    expect(suggestRuleLabel('shell', { command: cmd })).toBe('git commit:*, git push:*')
    const built = buildAllowRule('shell', { command: cmd })
    expect(built!.persist).toBe(true)
    expect(built!.rules.map((r) => `${r.type}:${r.pattern}`)).toEqual(['prefix:git commit', 'prefix:git push'])
  })

  it('deduplicates repeated prefixes in a compound', () => {
    // `git commit -m a && git commit --amend` is the same prefix twice
    // — saving it once is enough.
    const built = buildAllowRule('shell', { command: 'git commit -m a && git commit --amend' })
    expect(built!.rules).toHaveLength(1)
    expect(built!.rules[0]!.pattern).toBe('git commit')
  })

  it('mixes prefix + segment-exact when only some segments have prefixes', () => {
    // `git commit -m a && curl evil.com` — first segment has a clean
    // prefix, second segment doesn't (`evil.com` fails SUBCOMMAND_RE).
    // The earlier design collapsed this to a full-command exact rule,
    // throwing away the derivable `git commit:*`. We now save BOTH
    // (prefix for git commit, segment-exact for the curl), and the
    // label shows both so the user knows what's being approved.
    const cmd = 'git commit -m a && curl evil.com'
    expect(suggestRuleLabel('shell', { command: cmd })).toBe('git commit:*, curl evil.com')
    const built = buildAllowRule('shell', { command: cmd })
    expect(built!.persist).toBe(true)
    expect(built!.rules.map((r) => `${r.type}:${r.pattern}`)).toEqual(['prefix:git commit', 'exact:curl evil.com'])
  })

  // End-to-end: one click on a compound saves multiple rules; the
  // matcher then auto-approves future compound variants AND each rule
  // alone, but still refuses any compound containing an un-approved
  // command.
  it('compound approval covers future variants but not unrelated additions', () => {
    clearSessionRules()
    const built = buildAllowRule('shell', { command: 'git commit && git push' })!
    for (const r of built.rules) addSessionAllowRule(r)

    expect(sessionRulesMatch('shell', { command: 'git commit -m foo && git push' })).toBe(true)
    expect(sessionRulesMatch('shell', { command: 'cd /tmp && git commit -m a && git push origin main' })).toBe(true)
    expect(sessionRulesMatch('shell', { command: 'git commit --amend' })).toBe(true)
    expect(sessionRulesMatch('shell', { command: 'git push -u origin main' })).toBe(true)

    // `npm test` was never approved → re-prompt the whole compound.
    // (`git tag` would have been a less surprising choice but its bare
    // form is in the read-only git subcommand list, so it gets filtered
    // out of the segments-to-check.)
    expect(sessionRulesMatch('shell', { command: 'git commit -m a && git push && npm test' })).toBe(false)
    // Defence in depth: a half-approved compound where the second
    // segment has no derivable prefix must NOT auto-allow.
    expect(sessionRulesMatch('shell', { command: 'git commit -m a && curl evil.com' })).toBe(false)
    clearSessionRules()
  })

  it('returns null for enterPlanMode (no recurring action to remember)', () => {
    expect(suggestRuleLabel('enterPlanMode', {})).toBeNull()
  })

  it('returns "this MCP tool" when isMcp is true regardless of tool name', () => {
    // MCP tools used to fall through to the writeFile branch and render
    // as "all edits this session" — wrong text and wrong persistence
    // posture (MCP always-allow is written to disk via McpPermissionStore,
    // not session-only). The explicit isMcp flag bypasses the shell /
    // write fallbacks and returns the MCP-flavoured label.
    expect(suggestRuleLabel('filesystem__read_file', { path: '/tmp' }, true)).toBe('this MCP tool')
    expect(suggestRuleLabel('any_name_at_all', {}, true)).toBe('this MCP tool')
  })
})
