// godbot.mjs — ONE-STEP installer + runner for the Grounded Builder village.
// Double-click godbot.exe (or `node godbot.mjs`) and it will:
//   1. write the API keys into app/.env
//   2. npm-install the app dependencies if missing
//   3. download Paper 1.21.6 if missing, accept EULA
//   4. find or download a Java 21 JRE
//   5. start the Minecraft server and wait until it is ready
//   6. launch the autonomous village (society.mjs) + dashboard on :3600
// Quit with Ctrl+C — it shuts the server and bots down cleanly.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))

// --- API keys: environment variables or a local keys.env file (never committed) -
const KEYS_FILE = path.join(ROOT, 'keys.env')
if (fs.existsSync(KEYS_FILE)) {
  for (const line of fs.readFileSync(KEYS_FILE, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (m && m[2] && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
}
const JEV_API_KEY = process.env.JEV_API_KEY
const LLM_API_KEY = process.env.GROQ_API_KEY || process.env.CLINE_API_KEY // app reads it as CLINE_API_KEY
const APP = path.join(ROOT, 'app')
const SERVER = path.join(ROOT, 'server-1216')
const RUNTIME = path.join(ROOT, 'runtime')
const PAPER_URL = 'https://api.papermc.io/v2/projects/paper/versions/1.21.6/builds/48/downloads/paper-1.21.6-build-48.jar'
const TEMURIN_URL = 'https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jre/hotspot/normal/eclipse'

const say = (s) => console.log('[godbot] ' + s)
const die = (s) => { console.error('[godbot] FATAL: ' + s); process.exit(1) }
const exists = (p) => fs.existsSync(p)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function download(url, dest, label) {
  say(`downloading ${label}...`)
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) die(`download failed (${res.status}) for ${label}`)
  const total = Number(res.headers.get('content-length')) || 0
  const out = fs.createWriteStream(dest)
  let done = 0, last = 0
  await new Promise((resolve, reject) => {
    res.body.on('data', (c) => {
      done += c.length
      if (total && done - last > 5e6) { last = done; say(`  ${(done / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB`) }
    })
    res.body.pipe(out)
    res.body.on('error', reject)
    out.on('finish', resolve)
  })
}
function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { stdio: 'inherit', shell: false, ...opts }).status === 0
}
const portUp = () => {
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    '(Test-NetConnection 127.0.0.1 -Port 25565 -InformationLevel Quiet -WarningAction SilentlyContinue)'], { encoding: 'utf8' })
  return (r.stdout || '').trim() === 'True'
}

const kids = []
function track(p) { kids.push(p); p.once('exit', () => { const i = kids.indexOf(p); if (i >= 0) kids.splice(i, 1) }) }

async function main() {
  say('Grounded Builder — one-step install & run')
  if (!exists(APP)) die('run this from the repository root (app/ folder must exist)')

  // 1. keys
  if (!JEV_API_KEY || !LLM_API_KEY) {
    die('missing API keys — copy keys.env.example to keys.env in this folder and fill in your keys '
      + '(or set JEV_API_KEY and GROQ_API_KEY environment variables)')
  }
  fs.writeFileSync(path.join(APP, '.env'), `JEV_API_KEY=${JEV_API_KEY}\nCLINE_API_KEY=${LLM_API_KEY}\n`)
  say('API keys written to app/.env')

  // 2. node on PATH? (needed for npm + society.mjs)
  const nodeWhere = spawnSync('where.exe', ['node'], { encoding: 'utf8' })
  const nodeExe = nodeWhere.status === 0 ? nodeWhere.stdout.split(/\r?\n/)[0].trim() : null
  if (!nodeExe) die('Node.js 22+ is required on PATH — install it from https://nodejs.org')
  say('node: ' + nodeExe)

  // 3. dependencies
  if (!exists(path.join(APP, 'node_modules'))) {
    say('installing app dependencies (npm install)...')
    if (!sh('npm.cmd', ['install', '--no-fund', '--no-audit'], { cwd: APP })) die('npm install failed')
  } else say('app dependencies already installed')

  // 4. paper.jar + EULA
  if (!exists(path.join(SERVER, 'paper.jar'))) {
    fs.mkdirSync(SERVER, { recursive: true })
    await download(PAPER_URL, path.join(SERVER, 'paper.jar'), 'Paper 1.21.6')
  } else say('paper.jar present')
  fs.writeFileSync(path.join(SERVER, 'eula.txt'), 'eula=true\n')

  // 5. Java 21 — bundled runtime folder, PATH, or auto-download Temurin
  let java = null
  const rtJava = path.join(RUNTIME, 'jdk-21.0.12.1+1-jre', 'bin', 'java.exe')
  if (exists(rtJava)) { java = rtJava; say('java (bundled runtime)') }
  else {
    const w = spawnSync('where.exe', ['java'], { encoding: 'utf8' })
    if (w.status === 0) {
      const cand = w.stdout.split(/\r?\n/)[0].trim()
      const v = spawnSync(cand, ['-version'], { encoding: 'utf8' })
      if ((v.stderr || '').includes('"21.')) { java = cand; say('java (PATH): ' + cand) }
      else say('PATH java is not 21 — downloading JRE 21...')
    } else say('no java on PATH — downloading JRE 21...')
    if (!java) {
      fs.mkdirSync(RUNTIME, { recursive: true })
      const zip = path.join(RUNTIME, 'jre21.zip')
      await download(TEMURIN_URL, zip, 'Temurin JRE 21')
      say('extracting JRE...')
      const x = spawnSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force '${zip}' '${RUNTIME}'`])
      if (x.status !== 0) die('JRE extraction failed')
      fs.unlinkSync(zip)
      const jdk = fs.readdirSync(RUNTIME).find(d => /^jdk-21/.test(d) && exists(path.join(RUNTIME, d, 'bin', 'java.exe')))
      if (!jdk) die('JRE not found after extraction')
      java = path.join(RUNTIME, jdk, 'bin', 'java.exe')
      say('java (downloaded): ' + java)
    }
  }

  // 6. start server if not already running
  if (portUp()) say('Minecraft server already running on 25565')
  else {
    say('starting Minecraft server (first boot takes ~30-40s)...')
    const log = fs.openSync(path.join(SERVER, 'server.log'), 'a')
    const err = fs.openSync(path.join(SERVER, 'server.err'), 'a')
    track(spawn(java, ['-Xms2G', '-Xmx2G', '-jar', 'paper.jar', '--nogui'],
      { cwd: SERVER, stdio: ['ignore', log, err] }))
    const t0 = Date.now()
    for (;;) {
      await sleep(2000)
      if (portUp()) { say('server is UP on 25565'); break }
      if (Date.now() - t0 > 180000) die('server did not come up in 3 minutes — check server-1216\\server.log')
    }
  }

  // 7. launch the village
  say('launching the village — dashboard: http://localhost:3600')
  say('join the world at localhost:25565 and talk to the villagers in chat!')
  const society = spawn(nodeExe, ['society.mjs'], { cwd: APP, stdio: 'inherit' })
  track(society)
  society.on('exit', (c) => { say(`village exited (${c})`); process.exit(c ?? 0) })
}

main().then(() => {}).catch((e) => die(e.stack || e.message))

process.on('SIGINT', () => {
  say('shutting down — stopping bots and server...')
  for (const k of kids) { try { k.kill() } catch {} }
  spawnSync('powershell', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='java.exe'\" | Where-Object { $_.CommandLine -match 'paper.jar' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"])
  setTimeout(() => process.exit(0), 1500)
})

