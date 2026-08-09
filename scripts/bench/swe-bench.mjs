// @x-code-cli — SWE-bench runner for the `xc` CLI.
//
// Runs `xc` against SWE-bench instances inside per-task Docker containers
// and produces the predictions JSONL consumed by the official harness:
//
//   node scripts/bench/swe-bench.mjs --limit 10
//   pnpm bench:swe:score          # score the results (needs swebench pip pkg)
//
// Prerequisites: Docker running, an API key for the model provider
// (DEEPSEEK_API_KEY by default), and the `xc-bench:latest` image (built
// automatically on first run). Each instance: clone repo -> checkout base
// commit -> `xc -p -t -m <model>` on the issue text -> `git diff HEAD` as
// the model patch. Scoring is left to the official swebench harness, which
// applies the patch and runs the hidden tests in its own containers.
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const rootDir = resolve(import.meta.dirname, '..', '..')
const ROWS_URL = 'https://datasets-server.huggingface.co/rows'
const PASS_ENV = [
  'DEEPSEEK_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'ALIBABA_API_KEY',
  'XAI_API_KEY',
  'ZHIPU_API_KEY',
  'MOONSHOT_API_KEY',
  'OPENAI_COMPATIBLE_API_KEY',
  'OPENAI_COMPATIBLE_BASE_URL',
  'TAVILY_API_KEY',
  'BRAVE_API_KEY',
]

const USAGE = `SWE-bench runner for xc

Usage:
  node scripts/bench/swe-bench.mjs [options]

Options:
  --dataset <name>     HF dataset (default: princeton-nlp/SWE-bench_Verified)
  --limit <n>          Run only the first n instances
  --instances <csv>    Run specific instance ids (e.g. django__django-11099)
  --out <dir>          Results dir (default: bench/results, relative to repo root)
  --model <id>         Model alias passed to -m (default: deepseek)
  --timeout <sec>      Per-instance wall-clock timeout (default: 1200)
  --concurrency <n>    Parallel containers (default: 1; each is CPU/disk heavy)
  --image <name>       Runner image (default: xc-bench:latest)
  --no-build           Fail instead of building the runner image
  --keep               Keep the container after the run (debugging)
  --refresh            Re-download the dataset instead of using the cache
  -h, --help           Show this help`

function parseArgs(argv) {
  const opts = {
    dataset: 'princeton-nlp/SWE-bench_Verified',
    limit: null,
    instances: null,
    out: 'bench/results',
    model: 'deepseek',
    timeout: 1200,
    concurrency: 1,
    image: 'xc-bench:latest',
    noBuild: false,
    keep: false,
    refresh: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`missing value for ${arg}`)
      return argv[++i]
    }
    switch (arg) {
      case '--dataset':
        opts.dataset = next()
        break
      case '--limit':
        opts.limit = Number(next())
        break
      case '--instances':
        opts.instances = next()
        break
      case '--out':
        opts.out = next()
        break
      case '--model':
        opts.model = next()
        break
      case '--timeout':
        opts.timeout = Number(next())
        break
      case '--concurrency':
        opts.concurrency = Number(next())
        break
      case '--image':
        opts.image = next()
        break
      case '--no-build':
        opts.noBuild = true
        break
      case '--keep':
        opts.keep = true
        break
      case '--refresh':
        opts.refresh = true
        break
      case '-h':
      case '--help':
        console.log(USAGE)
        process.exit(0)
      default:
        throw new Error(`unknown argument: ${arg}`)
    }
  }
  if (opts.timeout <= 0 || opts.concurrency <= 0) throw new Error('--timeout and --concurrency must be positive')
  return opts
}

function log(msg) {
  console.log(msg)
}

// --- docker helpers ---------------------------------------------------------

function runCapture(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Error(`docker ${args[0]} failed: ${err.trim()}`)),
    )
  })
}

// Spawns `docker run` and guarantees the container dies when the timeout hits
// (killing the client alone would leave the container running with --rm).
function dockerRun(args, { timeoutMs, containerName }) {
  return new Promise((resolve) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      spawn('docker', ['stop', containerName], { stdio: 'ignore' })
    }, timeoutMs)
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: -1, timedOut: false, stderr: String(err) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, timedOut, stderr })
    })
  })
}

// --- dataset ----------------------------------------------------------------

async function fetchDataset(dataset, cacheFile, refresh) {
  if (!refresh && existsSync(cacheFile)) {
    log(`using cached dataset: ${cacheFile}`)
    return JSON.parse(readFileSync(cacheFile, 'utf-8'))
  }
  // Try config=default first (most single-config datasets), then without it.
  let rows = []
  for (const configParam of ['config=default&', '']) {
    let offset = 0
    let total = 0
    rows = []
    for (;;) {
      const url = `${ROWS_URL}?dataset=${encodeURIComponent(dataset)}&${configParam}split=test&length=100&offset=${offset}`
      const res = await fetch(url)
      if (!res.ok) break
      const json = await res.json()
      if (!json.rows || json.rows.length === 0) break
      rows.push(...json.rows.map((r) => r.row))
      total = json.num_rows_total ?? offset + json.rows.length
      offset += json.rows.length
      if (offset >= total) break
    }
    if (rows.length > 0) break
  }
  if (rows.length === 0) throw new Error(`failed to fetch dataset ${dataset} from HF datasets-server`)
  mkdirSync(dirname(cacheFile), { recursive: true })
  writeFileSync(cacheFile, JSON.stringify(rows))
  log(`fetched ${rows.length} instances from ${dataset}`)
  return rows
}

function selectInstances(rows, opts) {
  let list = rows
  if (opts.instances) {
    const wanted = new Set(opts.instances.split(',').map((s) => s.trim()))
    list = rows.filter((r) => wanted.has(r.instance_id))
    const missing = [...wanted].filter((id) => !list.some((r) => r.instance_id === id))
    if (missing.length > 0)
      log(`warning: ${missing.length} requested instance(s) not in dataset: ${missing.join(', ')}`)
  }
  if (opts.limit !== null) list = list.slice(0, opts.limit)
  if (list.length === 0) throw new Error('no instances selected')
  return list
}

// --- instance run -----------------------------------------------------------

function toDockerPath(p) {
  return p.replace(/\\/g, '/')
}

function buildScript(inst, opts) {
  return [
    'set -e',
    'cd /work',
    // GitHub pulls drop connections under load; retry before giving up.
    'for i in 1 2 3; do',
    `  git clone --quiet --no-tags https://github.com/${inst.repo}.git repo && break`,
    '  echo "clone attempt $i failed, retrying"',
    '  sleep 5',
    'done',
    'cd repo',
    `git checkout --quiet ${inst.base_commit}`,
    `xc -p -t -m ${opts.model} --no-plugins --no-hooks "$(cat /work/issue.txt)" > /work/agent.log 2>&1 || true`,
    'git add -A',
    // xc keeps session/file-history state under .x-code in the cwd — never
    // part of the solution patch.
    'git reset -q -- .x-code',
    'git diff HEAD > /work/patch.diff || true',
  ].join('\n')
}

async function runInstance(inst, idx, total, opts, paths) {
  const id = inst.instance_id
  const workDir = join(paths.workDir, id)
  rmSync(workDir, { recursive: true, force: true })
  mkdirSync(workDir, { recursive: true })
  writeFileSync(join(workDir, 'issue.txt'), inst.problem_statement || '')

  const containerName = `xc-bench-${id}`
  const envFlags = PASS_ENV.filter((k) => process.env[k] !== undefined).flatMap((k) => ['-e', k])
  const args = [
    'run',
    ...(opts.keep ? [] : ['--rm']),
    '-v',
    `${toDockerPath(workDir)}:/work`,
    '--name',
    containerName,
    ...envFlags,
    opts.image,
    'bash',
    '-lc',
    buildScript(inst, opts),
  ]

  const started = Date.now()
  const { code, timedOut, stderr } = await dockerRun(args, { timeoutMs: opts.timeout * 1000, containerName })
  const durationMs = Date.now() - started

  let status = 'done'
  if (timedOut) status = 'timeout'
  else if (code !== 0) status = 'error'

  const patchPath = join(workDir, 'patch.diff')
  const patch = existsSync(patchPath) ? readFileSync(patchPath, 'utf-8') : ''
  if (status === 'done') {
    appendFileSync(
      paths.predictions,
      JSON.stringify({ instance_id: id, model_name_or_path: `xc-${opts.model}`, model_patch: patch }) + '\n',
    )
  }

  const patchKb = (Buffer.byteLength(patch) / 1024).toFixed(1)
  const mins = (durationMs / 60000).toFixed(1)
  log(`[${idx + 1}/${total}] ${id} -> ${status} (${mins} min, patch ${patchKb} KB)`)
  if (status === 'error') log(`  docker stderr: ${stderr.trim().split('\n').slice(-3).join(' | ')}`)

  return { instance_id: id, status, duration_ms: durationMs, exit_code: code, patch_bytes: Buffer.byteLength(patch) }
}

async function runPool(instances, worker, concurrency) {
  const results = new Array(instances.length)
  let next = 0
  const runners = Array.from({ length: Math.min(concurrency, instances.length) }, async () => {
    while (next < instances.length) {
      const idx = next++
      results[idx] = await worker(instances[idx], idx)
    }
  })
  await Promise.all(runners)
  return results
}

// --- main -------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const resultsDir = resolve(rootDir, opts.out)
  mkdirSync(resultsDir, { recursive: true })
  const cacheFile = join(resultsDir, '.cache', opts.dataset.replace(/[^\w.-]+/g, '_') + '.json')
  const paths = {
    workDir: join(resultsDir, 'work'),
    predictions: join(resultsDir, 'predictions.jsonl'),
  }

  log(`dataset:  ${opts.dataset}`)
  log(`model:    ${opts.model}  (container: ${opts.image})`)
  log(`timeout:  ${opts.timeout}s  concurrency: ${opts.concurrency}`)
  log('')

  const rows = await fetchDataset(opts.dataset, cacheFile, opts.refresh)
  const instances = selectInstances(rows, opts)
  if (opts.limit === null && !opts.instances) {
    log(
      `warning: no --limit given — running all ${instances.length} instances. ` +
        'Start small (--limit 5) to gauge time and cost first.',
    )
  }
  log('')

  // Docker must be up before anything else touches it.
  await runCapture(['info'])
  try {
    await runCapture(['image', 'inspect', opts.image])
  } catch {
    if (opts.noBuild) throw new Error(`image ${opts.image} not found (--no-build given)`)
    log(`building ${opts.image} from scripts/bench/Dockerfile (first run only)...`)
    await runCapture(['build', '-t', opts.image, join(rootDir, 'scripts', 'bench')])
    log('image built')
  }

  rmSync(paths.predictions, { force: true })
  const runs = await runPool(
    instances,
    (inst, idx) => runInstance(inst, idx, instances.length, opts, paths),
    opts.concurrency,
  )

  const summary = runs.reduce(
    (acc, r) => {
      acc[r.status]++
      return acc
    },
    { done: 0, timeout: 0, error: 0 },
  )
  const totalMs = runs.reduce((acc, r) => acc + r.duration_ms, 0)
  log('')
  log(`=== summary ===`)
  log(
    `total ${runs.length} | done ${summary.done} | timeout ${summary.timeout} | error ${summary.error} | wall ${(totalMs / 60000).toFixed(1)} min`,
  )
  log(`predictions: ${paths.predictions}`)
  log('score with: pnpm bench:swe:score')
  const statsFile = join(resultsDir, 'stats.json')
  writeFileSync(statsFile, JSON.stringify({ summary, runs }, null, 2))
  log(`stats: ${statsFile}`)
  if (summary.error + summary.timeout > 0) process.exitCode = 2
}

main().catch((err) => {
  console.error(`\nfatal: ${err.message}`)
  process.exit(1)
})
