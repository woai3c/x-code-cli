// @x-code-cli — SWE-bench scoring wrapper.
//
// Feeds the predictions.jsonl produced by swe-bench.mjs into the official
// swebench harness, which rebuilds each repo in Docker, applies the patch,
// runs the hidden tests, and reports pass/fail per instance:
//
//   pnpm bench:swe:score [--predictions bench/results/predictions.jsonl]
//
// Requires: `pip install swebench` (or `uv tool install swebench`) and
// Docker. The harness pulls large per-repo images — first run is slow.
// On Windows the swebench harness fails to import (`resource` is Unix-only),
// so run it from WSL: pass --wsl and install swebench inside the WSL distro
// (the runner assumes a `~/swebench-venv` venv in the `Ubuntu` distro).
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const rootDir = resolve(import.meta.dirname, '..', '..')

const USAGE = `SWE-bench scoring wrapper

Usage:
  node scripts/bench/score.mjs [options]

Options:
  --predictions <file>  Predictions JSONL (default: bench/results/predictions.jsonl)
  --dataset <name>      HF dataset (default: princeton-nlp/SWE-bench_Verified)
  --workers <n>         Parallel evaluation containers (default: 8)
  --instance-ids <csv>  Score only these instances (debugging)
  --wsl                 Run the harness inside WSL Ubuntu (see header comment)
  -h, --help            Show this help`

function parseArgs(argv) {
  const opts = {
    predictions: 'bench/results/predictions.jsonl',
    dataset: 'princeton-nlp/SWE-bench_Verified',
    workers: 8,
    instanceIds: null,
    wsl: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`missing value for ${arg}`)
      return argv[++i]
    }
    switch (arg) {
      case '--predictions':
        opts.predictions = next()
        break
      case '--dataset':
        opts.dataset = next()
        break
      case '--workers':
        opts.workers = Number(next())
        break
      case '--instance-ids':
        opts.instanceIds = next()
        break
      case '--wsl':
        opts.wsl = true
        break
      case '-h':
      case '--help':
        console.log(USAGE)
        process.exit(0)
      default:
        throw new Error(`unknown argument: ${arg}`)
    }
  }
  return opts
}

// D:\res\... -> /mnt/d/res/... so WSL can see Windows paths.
function wslPath(p) {
  const abs = resolve(p)
  const m = abs.match(/^([A-Za-z]):\\(.*)$/)
  if (!m) return abs.replace(/\\/g, '/')
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const predictionsPath = opts.wsl ? wslPath(opts.predictions) : resolve(rootDir, opts.predictions)
  if (opts.wsl) {
    const winPath = resolve(rootDir, opts.predictions)
    if (!existsSync(winPath)) throw new Error(`predictions file not found: ${winPath} — run pnpm bench:swe first`)
  } else if (!existsSync(predictionsPath)) {
    throw new Error(`predictions file not found: ${predictionsPath} — run pnpm bench:swe first`)
  }

  const harnessArgs = [
    '-m',
    'swebench.harness.run_evaluation',
    '--dataset_name',
    opts.dataset,
    '--predictions_path',
    predictionsPath,
    '--max_workers',
    String(opts.workers),
  ]
  if (opts.instanceIds) harnessArgs.push('--instance_ids', opts.instanceIds)

  let child
  if (opts.wsl) {
    const cmd = `~/swebench-venv/bin/python ${harnessArgs.map((a) => `'${a}'`).join(' ')}`
    child = spawn('wsl', ['-d', 'Ubuntu', '-e', 'bash', '-lc', cmd], { stdio: 'inherit' })
  } else {
    child = spawn('python', harnessArgs, { stdio: 'inherit' })
  }

  const code = await new Promise((resolveCode) => child.on('close', resolveCode))
  if (code !== 0) {
    console.error('\nharness exited with code ' + code + '. Is swebench installed? Try: pip install swebench')
    process.exitCode = code
  }
}

main().catch((err) => {
  console.error(`\nfatal: ${err.message}`)
  process.exit(1)
})
