// activities.mjs — things a body can do besides build: fish, farm, wander, craft, decorate, sleep.
// Each takes a builder (from builder.mjs) and reports through its event channel.
import pathfinderPkg from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
const { goals } = pathfinderPkg

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
export const POND = { x1: 4, z1: 20, x2: 8, z2: 24, y: -61 }  // terraformed at boot
export const FIELD = { x1: -6, z1: 20, x2: -2, z2: 24, y: -61 } // tilled at boot

export async function goFish(b, { casts = 3 } = {}) {
  // Fish the NEAREST water, wherever the villager happens to be — not one fixed pond.
  let target = null
  try {
    const waterId = b.bot.registry.blocksByName.water.id
    const found = b.bot.findBlocks({ matching: waterId, maxDistance: 40, count: 1 })
    if (found.length) target = found[0]
  } catch {}
  const aim = target || new Vec3((POND.x1 + POND.x2) / 2, -60.5, (POND.z1 + POND.z2) / 2)
  if (target) await b.walkTo(target.x - 1, -60, target.z, { timeout: 15000 }).catch(() => {})
  await b.ensureItem('fishing_rod')
  try { await b.bot.lookAt(new Vec3(aim.x, -60.5, aim.z), true) } catch {}
  let caught = 0
  for (let i = 0; i < casts; i++) {
    try {
      await b.bot.fish()
      caught++
      b.note(`Caught one! That's ${caught} today.`)
    } catch (e) {
      b.note(`The fish aren't biting... (${e.message.slice(0, 60)})`)
      break
    }
  }
  return { caught, casts }
}

export async function goFarm(b) {
  // Till a small pop-up plot right where the villager stands — farming is a
  // thing you DO, not a place you are chained to.
  const p = b.bot.entity.position.floored()
  const x1 = p.x + 2, z1 = p.z + 2
  b.bot.chat(`/fill ${x1} -61 ${z1} ${x1 + 2} -61 ${z1 + 2} minecraft:farmland`)
  await sleep(400)
  await b.ensureItem('wheat_seeds')
  let planted = 0
  for (let x = x1; x <= x1 + 2; x++)
    for (let z = z1; z <= z1 + 2; z++) {
      const soil = b.bot.blockAt(new Vec3(x, -61, z))
      if (!soil || soil.name !== 'farmland') continue
      try {
        await b.bot.placeBlock(soil, new Vec3(0, 1, 0))
        planted++
      } catch {}
      await sleep(150)
    }
  b.note(`Tilled a little plot here. ${planted} seeds in the ground.`)
  return { planted }
}

export async function goWander(b, { radius = 12 } = {}) {
  const p = b.bot.entity.position.floored()
  const tx = p.x + Math.floor((Math.random() * 2 - 1) * radius)
  const tz = p.z + Math.floor((Math.random() * 2 - 1) * radius)
  try {
    await b.walkTo(tx, p.y, tz, { timeout: 10000 })
    return { wanderedTo: { x: tx, z: tz }, ok: true }
  } catch (e) {
    return { wanderedTo: { x: tx, z: tz }, ok: false, error: e.message }
  }
}

// Explore: walk to a random distant point and look around
export async function goExplore(b, { radius = 40 } = {}) {
  const p = b.bot.entity.position.floored()
  const tx = p.x + Math.floor((Math.random() * 2 - 1) * radius)
  const tz = p.z + Math.floor((Math.random() * 2 - 1) * radius)
  try {
    await b.walkTo(tx, -60, tz, { timeout: 20000 })
    // Look around
    await b.bot.look(Math.random() * Math.PI * 2, -0.3, true)
    await sleep(1000)
    return { explored: { x: tx, z: tz }, ok: true }
  } catch (e) {
    return { explored: { x: tx, z: tz }, ok: false, error: e.message }
  }
}

// Decorate: place lanterns, flowers, or banners around a location
export async function goDecorate(b, { cx, cz, radius = 4, item = 'lantern' } = {}) {
  await b.walkTo(cx, -60, cz)
  await b.ensureItem(item)
  let placed = 0
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2
    const dx = Math.round(Math.cos(angle) * radius)
    const dz = Math.round(Math.sin(angle) * radius)
    const x = cx + dx, z = cz + dz
    const ground = b.bot.blockAt(new Vec3(x, -60, z))
    if (ground && ground.name !== 'air') {
      try {
        await b.bot.placeBlock(ground, new Vec3(0, 1, 0))
        placed++
      } catch {}
    }
    await sleep(200)
  }
  b.note(`Decorated the area with ${placed} ${item}s.`)
  return { placed, item }
}

// Sleep: find a bed or just rest in place (creative mode, no实际需要 but RP)
export async function goSleep(b, { duration = 5000 } = {}) {
  const pos = b.bot.entity.position.floored()
  b.note(`*yawns* Time for a quick rest...`)
  await sleep(duration)
  b.note(`*stretches* Ready to go again!`)
  return { rested: true, at: { x: pos.x, z: pos.z } }
}

// Craft: get creative with building materials (RP in creative mode)
export async function goCraft(b, { item = 'oak_planks' } = {}) {
  await b.ensureItem(item)
  b.note(`Working on something with ${item.replace('_', ' ')}...`)
  await sleep(2000)
  return { crafted: item }
}
