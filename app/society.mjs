// society.mjs — spawn autonomous villager agents who live, work, talk, and
// resolve conflicts through the human lawgiver (@asupasuyo). No central director:
// each mind wakes on its own timer and its own whims.
// Run: node society.mjs   (fresh flat world recommended)
import fs from 'node:fs'
import { validatePlan, checkCollisions } from './planner.mjs'
import { createBuilder } from './builder.mjs'
import { createBus } from './bus.mjs'
import { createMind, designGroupPlan } from './mind.mjs'
import { POND, FIELD } from './activities.mjs'
import { log, startDashboard } from './logger.mjs'

const env = Object.fromEntries(
  fs.readFileSync(new URL('./.env', import.meta.url), 'utf8')
    .split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
)
const PERSONAS = JSON.parse(fs.readFileSync(new URL('./personas.json', import.meta.url), 'utf8'))
const NAMES = Object.keys(PERSONAS)

const bus = createBus({ humanName: 'asupasuyo' })
const plans = {}
const builders = {}
const minds = {}

// --- spawn bodies -----------------------------------------------------------------
for (const name of NAMES) {
  builders[name] = createBuilder({ username: name, onEvent: (t, d) => log('bot', t, d) })
}
for (const name of NAMES) { await builders[name].ready; log('system', 'bot-spawned', { user: name }) }
log('system', 'all-spawned', { bots: NAMES })

// Set all bots to creative mode
const admin = builders[NAMES[0]].bot
for (const name of NAMES) {
  admin.chat(`/gamemode creative ${name}`)
  log('system', 'gamemode-set', { user: name, mode: 'creative' })
}

// everyone can announce to everyone (used for conflict pings)
bus.bindSayAll((msg) => { for (const name of NAMES) builders[name].chat(msg) })

// --- world fixtures (admin terraforming, one-time) --------
const cmd = (c) => admin.chat(c)
cmd('/team add villagers')
cmd('/team modify villagers collisionRule never')
cmd('/team join villagers @a')
cmd(`/fill ${POND.x1} ${POND.y} ${POND.z1} ${POND.x2} ${POND.y} ${POND.z2} minecraft:water`)
cmd(`/fill ${FIELD.x1} ${FIELD.y} ${FIELD.z1} ${FIELD.x2} ${FIELD.y} ${FIELD.z2} minecraft:farmland`)
log('system', 'terraformed', { pond: POND, field: FIELD })

// --- wake the minds -------------------------------------------------------------------
for (const name of NAMES) {
  minds[name] = createMind({ name, persona: PERSONAS[name], builder: builders[name], bus, env, plans })
  log('system', 'mind-awake', { user: name, model: PERSONAS[name].model })
}

// --- lawgiver commands: assemble + group commissions ------------------------------------
const sayAll = (msg) => { for (const name of NAMES) builders[name].chat(msg) }
const announce = (msg) => builders.Willow.chat(msg) // council spokesperson — no 4x echo
const namedBot = (message) => { const l = message.toLowerCase(); return NAMES.find(n => l.includes(n.toLowerCase())) }

function playerPos(username) {
  const p = admin.players[username]?.entity?.position || admin.players[bus.humanName]?.entity?.position
  return p ? p.floored() : null
}

// Everyone drops what they're doing and gathers around the player.
async function assemble(username) {
  const pos = playerPos(username)
  if (!pos) { admin.chat('I cannot see you, lawgiver. Come closer.'); return null }
  sayAll('Assembling!')
  log('system', 'assemble', { at: { x: pos.x, y: pos.y, z: pos.z } })
  await Promise.all(NAMES.map((n, i) =>
    builders[n].walkTo(pos.x + (i % 2 ? 2 : -2), pos.y, pos.z + (i < 2 ? 2 : -2), { timeout: 20000 }).catch(() => {})
  ))
  return pos
}

// The whole village builds one commissioned structure for the player:
// one mind designs a showpiece plan, cells are split round-robin, all four
// bots build concurrently, then the result is read back and verified.
let commissionBusy = false
async function groupBuild(username, description) {
  if (commissionBusy) { sayAll('The council is already at work. One commission at a time.'); return }
  commissionBusy = true
  try {
    const pos = await assemble(username)
    const anchor = pos || admin.entity.position.floored()
    // find a clean site near the player (not on the garden, not on other plans)
    let origin = null
    for (const [dx, dz] of [[8, 8], [-8, 8], [8, -8], [-8, -8], [12, 0], [0, 12], [-12, 0], [0, -12]]) {
      const probe = []
      for (let px = 0; px < 16; px++) for (let pz = 0; pz < 16; pz++)
        probe.push({ x: anchor.x + dx + px, y: -60, z: anchor.z + dz + pz, block: 'oak_planks' })
      const v = validatePlan(probe)
      const col = checkCollisions({ commission_probe: probe, ...plans })
      if (v.ok && col.ok) { origin = { x: anchor.x + dx, y: -60, z: anchor.z + dz }; break }
    }
    if (!origin) { announce('No clean ground near you for such a build. Move somewhere open.'); return }
    announce(`The village answers your call: we build "${description}"!`)
    log('system', 'group-build-start', { description, origin })
    const plan = await designGroupPlan(env, PERSONAS.Willow, description, origin, plans)
    if (!plan.ok) { announce('The council could not agree on a design. Ask us again.'); log('system', 'group-build-failed', { error: plan.error }); return }
    plans.commission = plan.cells
    announce(`Plan ready: "${plan.description}" — ${plan.cells.length} blocks. Everyone takes a section!`)
    const sorted = [...plan.cells].sort((a, b) => a.y - b.y) // bottom-up for clean visuals
    const shares = NAMES.map(() => [])
    sorted.forEach((c, i) => shares[i % NAMES.length].push(c))
    await Promise.all(NAMES.map((n, i) => (async () => {
      if (!shares[i].length) return
      await builders[n].chat(`${n} takes ${shares[i].length} blocks.`)
      const r = await builders[n].placeCells(shares[i], { delay: 90 })
      log('bot', 'group-share-done', { user: n, total: r.total, failures: r.failures.length })
    })()))
    const v = await builders[NAMES[0]].verifyCells(plan.cells)
    announce(`Done, lawgiver! Verified ${v.matched}/${v.total} blocks match the plan.`)
    log('verifier', 'group-verify', { matched: v.matched, total: v.total, mismatched: v.mismatched.slice(0, 5) })
  } catch (e) {
    log('system', 'group-build-error', { error: e.message })
    announce('The commission hit a problem: ' + e.message.slice(0, 120))
  } finally { commissionBusy = false }
}

// --- chat wiring: everything flows through the bus --------------------------------------
const BOT_NAMES = new Set(NAMES)
for (const name of NAMES) {
  builders[name].bot.on('chat', (username, message) => {
    if (BOT_NAMES.has(username) || message.startsWith('/')) {
      if (BOT_NAMES.has(username)) bus.route(username, message, { isBot: true })
      return
    }
    log('system', 'player-chat', { username, message })
    // lawgiver commands intercept — handled ONCE (every bot hears every chat line,
    // so only the admin bot's listener may act on commands). Rulings stay law.
    if (name === NAMES[0] && !bus.getEscalation()) {
      const lower = message.toLowerCase()
      const wantsAssemble = /assemble|gather|come here|come to me|everyone come/.test(lower)
      const wantsBuild = /build|make|construct|create/.test(lower)
      if (!namedBot(message) && wantsBuild) {
        const desc = message.replace(/^(please\s+)?(everyone\s+|all\s+(of\s+you\s+)?|village[,]?\s*|team\s*)?(assemble\s+(and\s+)?|gather\s+(and\s+)?)?(build|make|construct|create)\s*(me\s*|us\s*)?(a\s+|an\s+)?/i, '').trim() || 'village monument'
        groupBuild(username, desc).catch(e => log('system', 'command-error', { error: e.message }))
        return
      }
      if (!namedBot(message) && wantsAssemble) {
        assemble(username).catch(e => log('system', 'command-error', { error: e.message }))
        return
      }
    }
    bus.route(username, message, { isBot: false })
  })
}

// --- first impressions: each mind introduces itself, staggered ---------------------------
let delay = 5000
for (const name of NAMES) {
  setTimeout(() => minds[name].think('you just woke up in a new village. Introduce yourself.'), delay)
  delay += 25000
}

startDashboard(3600)
log('system', 'ready', { mode: 'society', bots: NAMES, law: bus.humanName, dashboard: 'http://localhost:3600' })
console.log('SOCIETY RUNNING — the villagers live on their own. Dashboard: http://localhost:3600')
console.log('Commands: "assemble" | "build me a <thing>" (whole village builds it) | "<Name>, build ..." (one villager) | talk to them by name.')
