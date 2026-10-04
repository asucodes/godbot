// mind.mjs — villager brain. Direct HTTP calls, no Cline SDK tool-calling.
import { validatePlan, checkCollisions } from './planner.mjs'
import { goFish, goFarm, goWander, goExplore, goDecorate, goSleep, goCraft } from './activities.mjs'
import { log } from './logger.mjs'

const GROQ_BASE = 'https://api.groq.com/openai/v1'
const JEV_URL = 'https://api.experientiallabs.ai/v1/systemone'
// Split work across models so ambient chatter can never starve build designs:
// Groq rate-limits per model, so each lane gets its own quota pool.
const CHAT_MODEL = 'openai/gpt-oss-20b'   // short in-character lines
const DESIGN_MODEL = 'qwen/qwen3.8-27b'   // JSON structure plans
const wait = ms => new Promise(r => setTimeout(r, ms))

// --- global LLM gate --------------------------------------------------------
// All minds share one Groq TPM budget. Serialize requests and back off on 429
// so four bots never stampede the rate limiter.
let llmChain = Promise.resolve()
function llmGate(fn) {
  const run = llmChain.then(fn, fn)
  llmChain = run.then(() => wait(600), () => wait(600))
  return run
}

async function llmChatRaw(env, model, sys, usr, maxTok) {
  const body = { model, messages: [{ role: 'system', content: sys }, { role: 'user', content: usr }], max_tokens: maxTok || 220, temperature: 0.8 }
  if (model.includes('gpt-oss')) body.reasoning_effort = 'low' // gpt-oss spends max_tokens on hidden reasoning -> truncated replies
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(GROQ_BASE + '/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + (env.GROQ_API_KEY || env.CLINE_API_KEY), 'Content-Type': 'application/json' }, // CLINE_API_KEY holds the Groq key
      body: JSON.stringify(body),
    })
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after')) || 0
      const backoff = Math.max(retryAfter * 1000, 8000 * (attempt + 1))
      log('system', 'llm-429-backoff', { attempt: attempt + 1, waitMs: backoff })
      await wait(backoff); continue
    }
    if (!res.ok) throw new Error('LLM ' + res.status + ': ' + (await res.text()).slice(0, 200))
    var json = await res.json()
    var choices = json.choices || (json.data && json.data.choices) || []
    return choices[0]?.message?.content || ''
  }
  throw new Error('LLM 429: retries exhausted')
}
const llmChat = (env, model, sys, usr, maxTok) => llmGate(() => llmChatRaw(env, model, sys, usr, maxTok))
// Human-driven work SKIPS the queue — the lawgiver does not wait behind gossip.
// 429 backoff inside llmChatRaw still protects the rate limit.
const llmChatNow = (env, model, sys, usr, maxTok) => llmChatRaw(env, model, sys, usr, maxTok)

function extractJSON(text) {
  var m = text.match(/```(?:json)?\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*\})/)
  var raw = m ? m[1] : text
  raw = raw.replace(/\/\/[^\n]*/g, '')
  try { return JSON.parse(raw) } catch {}
  var attempt = raw
  var opens = (attempt.match(/\{/g) || []).length - (attempt.match(/\}/g) || []).length
  var brack = (attempt.match(/\[/g) || []).length - (attempt.match(/\]/g) || []).length
  attempt = attempt.replace(/,\s*$/, '').replace(/:\s*$/, ':""').replace(/,\s*"[^"]*"?\s*$/, '')
  for (var i = 0; i < brack; i++) attempt += ']'
  for (var i = 0; i < opens; i++) attempt += '}'
  try { return JSON.parse(attempt) } catch { return null }
}

// LLMs repeat cells and emit junk; keep the first of each coordinate.
function dedupeCells(cells) {
  var seen = new Set(), out = []
  for (var c of cells) {
    if (!c || typeof c.x !== 'number' || typeof c.y !== 'number' || typeof c.z !== 'number' || !c.block) continue
    var k = c.x + ',' + c.y + ',' + c.z
    if (seen.has(k)) continue
    seen.add(k)
    out.push({ x: c.x, y: c.y, z: c.z, block: String(c.block).replace(/^minecraft:/, '') })
  }
  return out
}

export function createMind({ name, persona, builder, bus, env, plans }) {
  const b = builder, p = persona
  const self = {
    thinking: false, inbox: [], model: persona.model, mood: 'neutral',
    lastSpoke: 0, cooldown: 15000,
    lastBuild: 0, buildCooldown: 15 * 60 * 1000,   // unsolicited builds are a rare whim
    lastAmbient: 0, ambientCooldown: 5 * 60 * 1000, // ambient chatter is rarer still
  }

  function say(msg) { return '[' + name + '] ' + msg }

  async function speak(message, { force = false } = {}) {
    if (!message || message.trim().length < 2 || message === '...') return false
    var now = Date.now()
    if (!force && now - self.lastSpoke < self.cooldown) return false
    await b.chat(say(message.slice(0, 200)))
    self.lastSpoke = now
    log('mind', 'says', { user: name, message })
    return true
  }

  async function jevDecide(context) {
    try {
      var body = { state: context, model: 'jev-latest', questions: {
        action: { type: 'choice', instructions: 'What should ' + name + ' do? Hobby: ' + p.hobby, criteria: {
          build: 'Design and build', fish: 'Go fishing', farm: 'Tend wheat field',
          wander: 'Stroll around village', explore: 'Walk to distant area',
          decorate: 'Place lanterns/flowers', sleep: 'Rest briefly', chat: 'Just talk',
        }},
        style: { type: 'choice', instructions: 'If building, what style?', criteria: {
          rustic: 'Wood and stone', modern: 'Glass and quartz',
          medieval: 'Stone bricks and towers', whimsical: 'Colorful wool', none: 'Not building',
        }},
      }}
      var r = await fetch(JEV_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + env.JEV_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!r.ok) throw new Error('JEV ' + r.status)
      var json = await r.json()
      var out = {}
      for (var k of Object.keys(json.answers || {})) out[k] = json.answers[k].choice
      log('jev', 'decision', { user: name, action: out.action, style: out.style })
      return out
    } catch (e) { log('jev', 'error', { user: name, error: e.message }); return { action: 'wander', style: 'none' } }
  }


  // Free-roam build site: near wherever the villager happens to be, never on the
  // protected garden or on top of another villager's plan.
  function pickBuildSite() {
    var pos = b.bot.entity.position.floored()
    for (var tries = 0; tries < 8; tries++) {
      var ang = Math.random() * Math.PI * 2
      var dist = 8 + Math.floor(Math.random() * 10)
      var sx = pos.x + Math.round(Math.cos(ang) * dist)
      var sz = pos.z + Math.round(Math.sin(ang) * dist)
      var probe = []
      for (var dx = 0; dx < 9; dx++) for (var dz = 0; dz < 9; dz++)
        probe.push({ x: sx + dx, y: -60, z: sz + dz, block: 'oak_planks' })
      if (!validatePlan(probe).ok) continue
      if (!checkCollisions({ ['probe_' + name]: probe, ...plans }).ok) continue
      return { x: sx, y: -60, z: sz }
    }
    return null
  }

  async function designAndBuild(style, userRequest) {
    var site = pickBuildSite()
    if (!site) { await speak('No free ground around here to build on.'); return { ok: false, error: 'no free site' } }
    var sys = 'You are a Minecraft architect. Output ONLY valid JSON, no comments, no markdown. Format: {"description":"short name","cells":[{"x":0,"y":0,"z":0,"block":"oak_planks"}]}. Coordinates are ABSOLUTE world coords. Ground is y=-60. Every coordinate must be UNIQUE. Use real Minecraft block IDs.'
    var buildDesc = userRequest || (style + ' structure')
    var usr = 'Design a ' + buildDesc + ' at origin x=' + site.x + ', y=-60, z=' + site.z + '. Style: ' + style + '. Stay within 12 blocks of origin. BE CREATIVE — pick a form that fits: cottage, watchtower, shrine, garden, statue, pier, market stall, ruin, archway, windmill... not just a box hut. 40-160 cells, built up from ground level so it stands. Materials: ' + p.materials + '. Use real Minecraft block IDs.'

    var plan = null, cells = [], v = { ok: false, violations: ['no plan'] }
    for (var attempt = 0; attempt < 2; attempt++) {
      var text = await (userRequest ? llmChatNow : llmChat)(env, DESIGN_MODEL, sys, usr, 6000)
      log('mind', 'llm-raw', { user: name, len: text.length, preview: text.slice(0, 300) })
      plan = extractJSON(text)
      cells = plan && Array.isArray(plan.cells) ? dedupeCells(plan.cells) : []
      v = cells.length ? validatePlan(cells) : { ok: false, violations: ['no valid cells'] }
      if (v.ok) break
      log('mind', 'plan-retry', { user: name, error: v.violations[0] })
      usr += '\nPrevious attempt was REJECTED: ' + v.violations[0] + '. Fix it. No duplicate coordinates, stay in bounds.'
    }
    if (!v.ok) {
      log('mind', 'plan-failed', { user: name, error: v.violations[0] })
      // LLM design failed (bad JSON / bad cells / no key) — fall back to the
      // deterministic persona blueprint so a human's build request never dies.
      if (BLUEPRINTS[p.style]) {
        plan = { description: p.style + ' (tried-and-true blueprint)' }
        cells = dedupeCells(BLUEPRINTS[p.style](plot))
        v = validatePlan(cells)
        log('mind', 'plan-blueprint-fallback', { user: name, style: p.style, cells: cells.length, ok: v.ok })
      }
      if (!v.ok) return { ok: false, error: v.violations[0] }
    }
    var col = checkCollisions({ [name]: cells, ...plans })
    if (!col.ok) return { ok: false, error: col.clashes[0] }
    plans[name] = cells
    log('mind', 'plan-build', { user: name, desc: plan.description, cells: cells.length })
    await speak('Building: ' + (plan.description || buildDesc) + '!', { force: true })
    // Stand OFF the footprint before placing so we never wall ourselves in.
    var xs = cells.map(c => c.x), zs = cells.map(c => c.z)
    await b.walkTo(Math.min(...xs) - 4, -60, Math.min(...zs) - 4)
    var r = await b.placeCells(cells, { delay: 100 })
    self.lastBuild = Date.now()
    var placed = r.total - r.failures.length
    await speak(placed === r.total
      ? 'Done. ' + (plan.description || buildDesc) + ', built proper.'
      : 'Done, but ' + r.failures.length + ' blocks fought me.')
    return { ok: true, placed, total: r.total }
  }

  async function doAction(action, style) {
    switch (action) {
      case 'build': return designAndBuild(style === 'none' ? 'rustic' : style, self.lastUserRequest)
      case 'fish': return goFish(b)
      case 'farm': return goFarm(b)
      case 'wander': return goWander(b, { radius: 22 })
      case 'explore': return goExplore(b)
      case 'decorate': { var pos = b.bot.entity.position.floored(); return goDecorate(b, { cx: pos.x, cz: pos.z }) }
      case 'sleep': return goSleep(b, { duration: 4000 })
      default: return { chatted: true }
    }
  }

  // One spoken line, in character. force=true bypasses the cooldown (humans get answers).
  async function replyTo(msgs, decision, { force = false } = {}) {
    var sysChat = 'You are ' + name + ', ' + p.role + ' in a village with Mason, Willow, Grimm and Pearl. Personality: ' + p.personality + ' Quirks: ' + p.quirks + ' Output ONLY the chat message, nothing else. Under 100 chars. Stay in character. When talking to another villager, address them by name so they hear you.'
    var userChat = msgs.length
      ? 'You received: ' + msgs.map(m => m.from + ': ' + m.text).join(' | ') + '. Reply to them directly (then you will ' + decision.action + ').'
      : 'You are about to ' + decision.action + '. Say one short in-character line.'
    try {
      var chatText = await (force ? llmChatNow : llmChat)(env, CHAT_MODEL, sysChat, userChat, 220)
      return await speak(chatText.replace(/^["']|["']$/g, '').trim(), { force: force || msgs.length > 0 })
    } catch (e) {
      log('system', 'llm-chat-error', { user: name, error: e.message })
      // LLM unavailable (bad key / outage) — stay in character with a canned
      // action line so the villager never goes silently dead during a demo.
      var canned = ACTION_LINES[decision.action] || ACTION_LINES.chat
      return await speak(msgs.length ? 'As you say. ' + canned : canned, { force: force || msgs.length > 0 })
    }
  }

  // In-character one-liners used when the LLM is unreachable.
  const ACTION_LINES = {
    build: 'Watch me work — this will stand a hundred years.',
    fish: 'The water calls. Back soon.',
    farm: 'Seeds first, gossip later.',
    wander: 'Stretching my legs a bit.',
    explore: 'Off to see what lies beyond.',
    decorate: 'This place could use a little light.',
    sleep: '*yawns* Just a short rest.',
    chat: 'Well met, friend.',
  }

  async function think(reason) {
    if (self.thinking) return
    self.thinking = true
    try {
      var inbox = self.inbox.splice(0)
      var fromHumans = inbox.filter(m => m.human)
      var fromBots = inbox.filter(m => !m.human)
      var pos = b.bot.entity.position.floored()
      var now = Date.now()

      // --- 1. decide the action ------------------------------------------------
      // Only HUMAN words can command a build. Bot gossip never does.
      var buildMsg = fromHumans.find(m => /build|make|create|construct/i.test(m.text))
      self.lastUserRequest = buildMsg
        ? buildMsg.text.replace(/^@?\w+[,:]?\s*/i, '').replace(/^(please\s+)?(build|make|create|construct)\s*(me\s*)?(a\s+|an\s+)?/i, '')
        : null
      if (self.lastUserRequest) log('mind', 'user-request', { user: name, request: self.lastUserRequest })

      var decision
      if (self.lastUserRequest) {
        decision = { action: 'build', style: 'none' } // the human's word is law — no JEV needed
      } else {
        decision = await jevDecide({ name: name, mood: self.mood, pos: { x: pos.x, z: pos.z }, inbox: inbox.map(m => m.from + ': ' + m.text), reason: reason })
        if (decision.action === 'build' && now - self.lastBuild < self.buildCooldown)
          decision.action = p.hobby === 'build' ? 'wander' : p.hobby
      }

      // --- 2. decide whether to speak -------------------------------------------
      // Humans always get an answer. Bot chatter: coin flip. Ambient: rare.
      if (fromHumans.length) await replyTo(fromHumans, decision, { force: true })
      else if (reason.indexOf('woke up') >= 0) await replyTo([], decision, { force: true })
      else if (fromBots.length && Math.random() < 0.35) await replyTo(fromBots, decision)
      else if (!inbox.length && Math.random() < 0.15 && now - self.lastAmbient > self.ambientCooldown) {
        if (await replyTo([], decision)) self.lastAmbient = now
      }

      // --- 3. act ---------------------------------------------------------------
      var result = await doAction(decision.action, decision.style)
      log('mind', 'acted', { user: name, action: decision.action, result: JSON.stringify(result).slice(0, 150) })
    } catch (e) { log('system', 'mind-error', { user: name, error: e.message }) }
    finally {
      self.thinking = false
      // messages that arrived mid-think get their own cycle
      if (self.inbox.length) setTimeout(() => think('queued messages'), 1500)
    }
  }

  bus.registerInbox(name, function(msg) { self.inbox.push(msg); think('message from ' + msg.from) })
  async function loop() {
    while (true) {
      await wait(60000 + Math.floor(Math.random() * 60000))
      if (!self.thinking) think('time passes')
    }
  }
  loop()
  return { name: name, think: think, self: self }
}

// --- commissioned group builds ------------------------------------------------
// One mind designs a larger plan that the whole village then builds together.
// Module-level so society.mjs can call it for player commissions.
export async function designGroupPlan(env, persona, description, origin, plans) {
  var sys = 'You are a master Minecraft architect. Output ONLY valid JSON, no comments, no markdown. Format: {"description":"short name","cells":[{"x":0,"y":0,"z":0,"block":"oak_planks"}]}. Coordinates are ABSOLUTE world coords. Ground is y=-60. Every coordinate must be UNIQUE. Use real Minecraft block IDs.'
  var usr = 'The village is commissioned to build: "' + description + '". Design it at origin x=' + origin.x + ', y=-60, z=' + origin.z + '. Stay within 14 blocks of origin. This is a SHOWPIECE — make it clearly recognizable as a ' + description + '. 100-220 cells, built up from ground level. Keep the JSON COMPACT. Materials palette: ' + persona.materials + ' plus any fitting blocks. Use real Minecraft block IDs.'
  for (var attempt = 0; attempt < 2; attempt++) {
    var text = await llmChatNow(env, DESIGN_MODEL, sys, usr, 5000)
    log('mind', 'group-llm-raw', { len: text.length, preview: text.slice(0, 200) })
    var plan = extractJSON(text)
    var cells = plan && Array.isArray(plan.cells) ? dedupeCells(plan.cells) : []
    var v = cells.length ? validatePlan(cells) : { ok: false, violations: ['no valid cells'] }
    if (v.ok) {
      var col = checkCollisions({ commission: cells, ...plans })
      if (col.ok) return { ok: true, cells, description: (plan && plan.description) || description }
      v = { ok: false, violations: [col.clashes[0]] }
    }
    log('mind', 'group-plan-retry', { error: v.violations[0] })
    usr += '\nPrevious attempt was REJECTED: ' + v.violations[0] + '. Fix it. No duplicate coordinates, stay in bounds, avoid the protected garden.'
  }
  return { ok: false, error: 'could not design a valid plan' }
}

