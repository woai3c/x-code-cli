import readline from 'node:readline'

const mode = process.argv[2] ?? 'repl'

function size() {
  const [cols, rows] = process.stdout.getWindowSize?.() ?? [process.stdout.columns, process.stdout.rows]
  return `${cols ?? 0}x${rows ?? 0}`
}

process.stdout.write(`READY:${process.stdin.isTTY === true}:${process.stdout.isTTY === true}:${size()}\n`)

if (mode === 'interrupt') {
  process.on('SIGINT', () => {
    process.stdout.write('INTERRUPTED\n', () => process.exit(130))
  })
  process.stdin.resume()
  setInterval(() => {}, 1_000)
} else {
  const input = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  input.on('SIGINT', () => {
    process.stdout.write('INTERRUPTED\n', () => process.exit(130))
  })
  input.on('line', (line) => {
    if (line === 'exit') {
      input.close()
      process.exit(0)
    } else if (line === 'size') {
      process.stdout.write(`SIZE:${size()}\n`)
    } else {
      process.stdout.write(`VALUE:${line}\n`)
    }
  })
}
