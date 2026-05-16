import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'

const rootDir = resolve(import.meta.dirname, '..')
const packages = ['packages/core/package.json', 'packages/cli/package.json']
const currentVersion = JSON.parse(readFileSync(resolve(rootDir, packages[0]), 'utf-8')).version

function run(cmd, opts) {
  console.log(`\n> ${cmd}`)
  // Use shell: true for cross-platform compatibility (Windows needs this for some commands)
  return execSync(cmd, { stdio: 'inherit', cwd: rootDir, shell: true, ...opts })
}

function runCapture(cmd) {
  // Use shell: true for cross-platform compatibility (Windows cmd.exe vs Unix sh)
  return execSync(cmd, { cwd: rootDir, encoding: 'utf-8', shell: true }).trim()
}

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((r) =>
    rl.question(question, (a) => {
      rl.close()
      r(a)
    }),
  )
}

function bumpVersion(version, type) {
  const [major, minor, patch] = version.split('.').map(Number)
  switch (type) {
    case 'patch':
      return `${major}.${minor}.${patch + 1}`
    case 'minor':
      return `${major}.${minor + 1}.0`
    case 'major':
      return `${major + 1}.0.0`
    default:
      return type
  }
}

function updatePackageVersion(pkgPath, version) {
  const fullPath = resolve(rootDir, pkgPath)
  const pkg = JSON.parse(readFileSync(fullPath, 'utf-8'))
  pkg.version = version
  writeFileSync(fullPath, JSON.stringify(pkg, null, 2) + '\n')
}

function generateChangelog(version) {
  // Use try-catch instead of Unix shell operators (2>/dev/null || echo) for Windows compatibility
  let lastTag
  try {
    lastTag = runCapture('git describe --tags --abbrev=0')
  } catch {
    lastTag = ''
  }
  const range = lastTag ? `${lastTag}..HEAD` : 'HEAD'
  const log = runCapture(`git log ${range} --pretty=format:"%s (%h)" --no-merges`)

  if (!log) return ''

  // Only user-facing changes appear in the changelog.
  // refactor / docs / chore / ci / style / test / release commits are filtered out.
  const groups = { feat: [], fix: [], perf: [] }
  const labels = {
    feat: 'Features',
    fix: 'Bug Fixes',
    perf: 'Performance',
  }

  for (const line of log.split('\n')) {
    const match = line.match(/^(\w+)(?:\(.+?\))?!?:\s*(.+)$/)
    if (match && match[1] in groups) {
      groups[match[1]].push(match[2])
    }
  }

  const hasContent = Object.values(groups).some((items) => items.length > 0)
  if (!hasContent) return ''

  let md = `## v${version} (${new Date().toISOString().slice(0, 10)})\n\n`
  for (const [type, items] of Object.entries(groups)) {
    if (items.length === 0) continue
    md += `### ${labels[type]}\n\n`
    for (const item of items) md += `- ${item}\n`
    md += '\n'
  }

  return md
}

// --- main ---
console.log(`\nCurrent version: v${currentVersion}\n`)
console.log('  1) patch  → v' + bumpVersion(currentVersion, 'patch'))
console.log('  2) minor  → v' + bumpVersion(currentVersion, 'minor'))
console.log('  3) major  → v' + bumpVersion(currentVersion, 'major'))
console.log('  4) custom')

const choice = await ask('\nSelect version type (1/2/3/4): ')
const typeMap = { 1: 'patch', 2: 'minor', 3: 'major' }

let targetVersion
if (choice === '4') {
  targetVersion = await ask('Enter custom version: ')
  if (!/^\d+\.\d+\.\d+/.test(targetVersion)) {
    console.error('Invalid version format')
    process.exit(1)
  }
} else if (typeMap[choice]) {
  targetVersion = bumpVersion(currentVersion, typeMap[choice])
} else {
  console.error('Invalid choice')
  process.exit(1)
}

const confirm = await ask(`\nRelease v${targetVersion}? (y/N): `)
if (confirm.toLowerCase() !== 'y') {
  console.log('Cancelled.')
  process.exit(0)
}

// 1. Update versions
console.log('\nUpdating package versions...')
for (const pkg of packages) {
  updatePackageVersion(pkg, targetVersion)
  console.log(`  ${pkg} → v${targetVersion}`)
}

// 2. Generate changelog
console.log('\nGenerating changelog...')
const changelog = generateChangelog(targetVersion)
const changelogPath = resolve(rootDir, 'CHANGELOG.md')
let existingChangelog = ''
try {
  existingChangelog = readFileSync(changelogPath, 'utf-8')
} catch {}
writeFileSync(changelogPath, changelog + existingChangelog)
console.log('  CHANGELOG.md updated')

// 3. Build
run('pnpm build')

// 4. Git commit & tag
run('git add -A')
run(`git commit -m "release: v${targetVersion}"`)
run(`git tag v${targetVersion}`)

// 5. Push
run('git push')
run('git push --tags')

console.log(`\nv${targetVersion} released! GitHub Action will publish to npm automatically.`)
