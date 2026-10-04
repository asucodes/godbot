// builder.mjs — Mineflayer bot wrapper: progressive placement, removal, verification.
// Bot is an opped real player in creative mode. It places/breaks every block itself;
// it repositions with /tp (ground-level only — mid-air teleports trigger movement kicks).
import mineflayer from 'mineflayer'
import { Vec3 } from 'vec3'
import pathfinderPkg from 'mineflayer-pathfinder'

const { pathfinder, Movements, goals } = pathfinderPkg
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const AIR = new Set(['air', 'cave_air', 'void_air'])

export function createBuilder({ onEvent = () => {}, host = '127.0.0.1', port = 25565, version = '1.21.6', username = 'ClineGodbot' } = {}) {
  const bot = mineflayer.createBot({ host, port, username, version, auth: 'offline' })
  bot.setMaxListeners(30) // many pending forcedMove one-shot listeners during tpTo bursts
  bot.loadPlugin(pathfinder)
  const ready = new Promise((resolve, reject) => {
    bot.once('spawn', () => resolve())
    bot.once('error', reject)
  })
  const emit = (type, data) => onEvent(type, { user: username, ...data })

  async function chat(msg) { try { bot.chat(msg) } catch {} emit('bot-chat', { msg }) }

  // Log/dashboard-only note — never spoken in game chat.
  async function note(msg) { emit('bot-note', { msg }) }

  async function ensureItem(name) {
    const held = bot.heldItem
    if (held && held.name === name) return
    let item = bot.inventory.items().find(i => i.name === name)
    if (!item) {
      bot.chat(`/give @s minecraft:${name} 64`)
      const t0 = Date.now()
      while (!item && Date.now() - t0 < 3000) {
        await sleep(150)
        item = bot.inventory.items().find(i => i.name === name)
      }
      if (!item) throw new Error(`could not obtain ${name}`)
    }
    await bot.equip(item, 'hand')
  }

  // Ground-level teleport: target cell must have solid ground directly below.
  // Uses /execute to suppress TP chat spam.
  async function tpTo(x, y, z) {
    const moved = new Promise(r => bot.once('forcedMove', r))
    bot.chat(`/execute as @s at @s run tp @s ${x} ${y} ${z}`)
    await Promise.race([moved, sleep(3000)])
    bot.entity.velocity.set(0, 0, 0)
    await sleep(120)
  }

  // Walk to position using pathfinding (natural movement, no TP spam).
  // Only TP for long distances (>30 blocks).
  async function walkTo(x, y, z, { timeout = 8000 } = {}) {
    const current = bot.entity.position.floored()
    const dist = Math.sqrt((current.x - x) ** 2 + (current.z - z) ** 2)
    if (dist > 30) { await tpTo(x, y, z); return }
    try {
      const moves = new Movements(bot)
      bot.pathfinder.setMovements(moves)
      await Promise.race([
        bot.pathfinder.goto(new goals.GoalNearXZ(x, z, 1)),
        sleep(timeout).then(() => { bot.pathfinder.stop(); throw new Error('walk timeout') })
      ])
    } catch { await tpTo(x, y, z) }
  }

  const V = (p) => new Vec3(p.x, p.y, p.z)
  const blockAt = (p) => bot.blockAt(V(p))
  const solid = (p) => { const b = blockAt(p); return b && !AIR.has(b.name) ? b : null }

  // Find a reference block + standing spot (air cell with solid below, within reach).
  function findPlacement(cell) {
    const t = { x: cell.x, y: cell.y, z: cell.z }
    const horizontal = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]
    // 1) prefer a solid horizontal neighbor: stand on top of it
    for (const [dx, , dz] of horizontal) {
      const rp = { x: t.x + dx, y: t.y, z: t.z + dz }
      if (solid(rp)) {
        const stand = { x: rp.x, y: rp.y + 1, z: rp.z }
        if (!solid(stand)) return { refPos: rp, face: { x: -dx, y: 0, z: -dz }, stand }
      }
    }
    // 2) fall back to the block below: stand on a ground-level neighbor cell
    const below = { x: t.x, y: t.y - 1, z: t.z }
    if (solid(below)) {
      for (const [dx, , dz] of horizontal) {
        const s = { x: t.x + dx, y: t.y, z: t.z + dz }
        if (!solid(s) && solid({ x: s.x, y: s.y - 1, z: s.z }))
          return { refPos: below, face: { x: 0, y: 1, z: 0 }, stand: s }
      }
    }
    return null
  }

  async function placeOne(cell) {
    try {
      const existing = blockAt(cell)
      if (existing && existing.name === cell.block) return { ok: true, cell, skipped: true }
      // Walk next to the cell so the bot visibly builds, then place via /setblock (opped creative bot).
      const bp = bot.entity.position.floored()
      const dist = Math.sqrt((bp.x - cell.x) ** 2 + (bp.z - cell.z) ** 2)
      if (dist > 5) await walkTo(cell.x, cell.y, cell.z)
      try { await bot.lookAt(new Vec3(cell.x + 0.5, cell.y + 0.5, cell.z + 0.5)) } catch {}
      bot.chat('/setblock ' + cell.x + ' ' + cell.y + ' ' + cell.z + ' minecraft:' + cell.block)
      await sleep(150)
      const now = blockAt(cell)
      if (now && now.name === cell.block) return { ok: true, cell }
      // Fallback: physical placement against an adjacent block
      const p = findPlacement(cell)
      if (!p) return { ok: false, cell, error: 'setblock rejected and no reachable placement position' }
      await Promise.race([ensureItem(cell.block), sleep(5000).then(() => { throw new Error('item timeout') })])
      const ref = blockAt(p.refPos)
      if (!ref || AIR.has(ref.name)) return { ok: false, cell, error: 'reference block vanished' }
      try { await bot.placeBlock(ref, new Vec3(p.face.x, p.face.y, p.face.z)) } catch (e) { return { ok: false, cell, error: e.message } }
      await sleep(60)
      return { ok: true, cell }
    } catch (e) { return { ok: false, cell, error: e.message } }
  }

  async function removeOne(cell) {
    const t = blockAt(cell)
    if (!t || AIR.has(t.name)) return { ok: true, cell, skipped: true }
    bot.chat('/setblock ' + cell.x + ' ' + cell.y + ' ' + cell.z + ' minecraft:air')
    await sleep(120)
    const now = blockAt(cell)
    if (!now || AIR.has(now.name)) return { ok: true, cell }
    const p = findPlacement(cell)
    if (!p) return { ok: false, cell, error: 'setblock air rejected and no reachable dig position' }
    await walkTo(p.stand.x, p.stand.y, p.stand.z)
    try { await bot.dig(blockAt(cell)) } catch (e) { return { ok: false, cell, error: e.message } }
    await sleep(40)
    return { ok: true, cell }
  }

  // Progressive build with pacing + progress events.
  // Self-avoidance: never fill a cell our own body is standing in — step
  // outside the plan's bounding box first, then keep building.
  async function placeCells(cells, { delay = 180 } = {}) {
    const failures = []
    const remaining = new Set(cells.map(c => c.x + ',' + c.y + ',' + c.z))
    const xs = cells.map(c => c.x), zs = cells.map(c => c.z)
    const outX = Math.min(...xs) - 4, outZ = Math.min(...zs) - 4
    for (let i = 0; i < cells.length; i++) {
      const bp = bot.entity.position.floored()
      if (remaining.has(bp.x + ',' + bp.y + ',' + bp.z) || remaining.has(bp.x + ',' + (bp.y + 1) + ',' + bp.z)) {
        emit('build-stepout', { at: { x: bp.x, y: bp.y, z: bp.z } })
        await walkTo(outX, bp.y, outZ)
      }
      const r = await placeOne(cells[i])
      remaining.delete(cells[i].x + ',' + cells[i].y + ',' + cells[i].z)
      if (!r.ok) { failures.push(r); emit('build-fail', { cell: cells[i], error: r.error }) }
      if (i % 5 === 0 || i === cells.length - 1)
        emit('build-progress', { done: i + 1, total: cells.length, failures: failures.length })
      await sleep(delay)
    }
    return { total: cells.length, failures }
  }

  async function removeCells(cells, { delay = 100 } = {}) {
    const failures = []
    for (let i = 0; i < cells.length; i++) {
      const r = await removeOne(cells[i])
      if (!r.ok) failures.push(r)
      if (i % 5 === 0 || i === cells.length - 1)
        emit('remove-progress', { done: i + 1, total: cells.length, failures: failures.length })
      await sleep(delay)
    }
    return { total: cells.length, failures }
  }

  // Read-back verification. TPs to the plan center first so chunks are loaded.
  async function verifyCells(cells) {
    if (!cells.length) return { matched: 0, mismatched: [], total: 0 }
    const cx = cells.reduce((s, c) => s + c.x, 0) / cells.length
    const cz = cells.reduce((s, c) => s + c.z, 0) / cells.length
    await walkTo(Math.round(cx), -60, Math.round(cz))
    await sleep(500)
    const mismatched = []
    for (const c of cells) {
      const b = blockAt(c)
      const actual = b ? b.name : null
      if (actual !== c.block) mismatched.push({ ...c, actual })
    }
    return { matched: cells.length - mismatched.length, mismatched, total: cells.length }
  }

  // Snapshot current world blocks at given positions (revision before/after proof).
  function snapshot(cells) {
    const out = {}
    for (const c of cells) {
      const b = blockAt(c)
      out[`${c.x},${c.y},${c.z}`] = b ? b.name : null
    }
    return out
  }

  return { bot, ready, chat, note, ensureItem, tpTo, walkTo, placeCells, removeCells, verifyCells, snapshot, Movements, goals }
}

