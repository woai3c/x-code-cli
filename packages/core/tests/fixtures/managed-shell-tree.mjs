import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const fixturePath = fileURLToPath(import.meta.url)
const role = process.argv[2]
const behavior = process.argv[3] ?? 'graceful'

if (role === 'descendant') {
  process.on('SIGTERM', behavior === 'ignore-term' ? () => {} : () => process.exit(0))
  setInterval(() => {}, 1_000)
} else {
  const descendant = spawn(
    process.execPath,
    [fixturePath, 'descendant', behavior === 'force' ? 'ignore-term' : 'graceful'],
    { stdio: 'ignore', windowsHide: true },
  )
  await new Promise((resolve, reject) => {
    descendant.once('error', reject)
    process.stdout.write(`DESCENDANT:${descendant.pid}\n`, (error) => (error ? reject(error) : resolve()))
  })

  if (behavior === 'root-exit') process.exit(0)
  process.on('SIGTERM', behavior === 'force' ? () => {} : () => process.exit(0))
  setInterval(() => {}, 1_000)
}
