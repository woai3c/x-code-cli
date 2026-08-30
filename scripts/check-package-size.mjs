import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const MIB = 1024 * 1024
const limits = {
  packed: 3.5 * MIB,
  unpacked: 12.75 * MIB,
  files: 42,
}
const cliPackage = JSON.parse(readFileSync(resolve('packages/cli/package.json'), 'utf8'))
const requiredRuntimeDependencies = ['@vscode/ripgrep', 'fs-ext-extra-prebuilt', 'undici']
const requiredNativeArtifacts = [
  'dist/native/windows/x64/xc-shell-supervisor.exe',
  'dist/native/windows/x64/xc-peer-broker.exe',
  'dist/native/windows/arm64/xc-shell-supervisor.exe',
  'dist/native/windows/arm64/xc-peer-broker.exe',
]
const nativeArtifactLimit = 0.4 * MIB

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const result = spawnSync(npm, ['pack', './packages/cli', '--dry-run', '--ignore-scripts', '--json'], {
  encoding: 'utf8',
  shell: process.platform === 'win32',
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})

if (result.error) {
  console.error(`Failed to run npm pack: ${result.error.message}`)
  process.exit(1)
}
if (result.status !== 0) {
  process.stderr.write(result.stderr)
  process.exit(result.status ?? 1)
}

let pack
try {
  const parsed = JSON.parse(result.stdout)
  pack = Array.isArray(parsed) ? parsed[0] : parsed
} catch {
  console.error('npm pack did not return valid JSON')
  process.stderr.write(result.stderr)
  process.exit(1)
}

const files = Array.isArray(pack?.files) ? pack.files : []
const packedSize = Number(pack?.size)
const unpackedSize = Number(pack?.unpackedSize)
const violations = []

for (const dependency of requiredRuntimeDependencies) {
  if (typeof cliPackage.dependencies?.[dependency] !== 'string') {
    violations.push(`required runtime dependency is not declared: ${dependency}`)
  }
}
for (const artifactPath of requiredNativeArtifacts) {
  const artifact = files.find((file) => file.path === artifactPath)
  if (!artifact) violations.push(`required native artifact is missing: ${artifactPath}`)
  else if (Number(artifact.size) > nativeArtifactLimit) {
    violations.push(
      `native artifact ${artifactPath} size ${formatBytes(Number(artifact.size))} exceeds ${formatBytes(nativeArtifactLimit)}`,
    )
  }
}

if (!Number.isFinite(packedSize) || packedSize > limits.packed) {
  violations.push(`packed size ${formatBytes(packedSize)} exceeds ${formatBytes(limits.packed)}`)
}
if (!Number.isFinite(unpackedSize) || unpackedSize > limits.unpacked) {
  violations.push(`unpacked size ${formatBytes(unpackedSize)} exceeds ${formatBytes(limits.unpacked)}`)
}
if (files.length > limits.files) {
  violations.push(`file count ${files.length} exceeds ${limits.files}`)
}

const sourceMaps = files.filter((file) => typeof file.path === 'string' && file.path.endsWith('.map'))
const declarations = files.filter((file) => typeof file.path === 'string' && /\.d\.(?:ts|mts|cts)$/.test(file.path))
if (sourceMaps.length > 0)
  violations.push(`source maps are published: ${sourceMaps.map((file) => file.path).join(', ')}`)
if (declarations.length > 0) {
  violations.push(`declaration files are published: ${declarations.map((file) => file.path).join(', ')}`)
}

console.log(
  `CLI package: ${formatBytes(packedSize)} packed, ${formatBytes(unpackedSize)} unpacked, ${files.length} files`,
)

if (violations.length > 0) {
  console.error('\nPackage gate failed:')
  for (const violation of violations) console.error(`- ${violation}`)
  console.error('\nLargest published files:')
  for (const file of [...files].sort((a, b) => Number(b.size) - Number(a.size)).slice(0, 20)) {
    console.error(`- ${formatBytes(Number(file.size)).padStart(10)}  ${file.path}`)
  }
  process.exit(1)
}

console.log('Package gate passed')

function formatBytes(bytes) {
  return Number.isFinite(bytes) ? `${(bytes / MIB).toFixed(2)} MiB` : 'unknown'
}
