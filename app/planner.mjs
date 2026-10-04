// planner.mjs — plan validation and collision checking. Pure functions, no side effects.
// The LLM designs structures freely; these are the guardrails:
//   - no touching the protected garden
//   - stay inside world height bounds
//   - no duplicate cells, sane plan sizes
//   - no two villagers building in the same cell
// Run inline tests with: node planner.mjs test

export const CONFIG = {
  // Protected garden (demo fixture): axis-aligned box, any y. Bots never modify these cells.
  garden: { x1: 10, z1: 10, x2: 16, z2: 16 },
  yMin: -64,
  yMax: 319,
  maxPlanSize: 500,
}

const key = (c) => `${c.x},${c.y},${c.z}`

function inBox(c, b) {
  return c.x >= b.x1 && c.x <= b.x2 && c.z >= b.z1 && c.z <= b.z2
}

export function validatePlan(cells, cfg = CONFIG) {
  const violations = []
  const seen = new Set()
  for (const c of cells) {
    if (c.y < cfg.yMin || c.y > cfg.yMax)
      violations.push(`out of world bounds: y=${c.y} at ${key(c)}`)
    if (inBox(c, cfg.garden))
      violations.push(`protected garden overlap at ${key(c)}`)
    if (seen.has(key(c))) violations.push(`duplicate cell ${key(c)}`)
    seen.add(key(c))
  }
  if (cells.length > cfg.maxPlanSize)
    violations.push(`plan too large: ${cells.length} cells (max ${cfg.maxPlanSize})`)
  return { ok: violations.length === 0, violations }
}

export function checkCollisions(namedPlans) {
  const seen = new Map()
  const clashes = []
  for (const [name, cells] of Object.entries(namedPlans))
    for (const c of cells) {
      const k = key(c)
      if (seen.has(k)) clashes.push(`${name} overlaps ${seen.get(k)} at ${k}`)
      seen.set(k, name)
    }
  return { ok: clashes.length === 0, clashes }
}

if (process.argv[2] === 'test') {
  const assert = (name, cond) => { console.log(cond ? `ok - ${name}` : `FAIL - ${name}`); if (!cond) process.exitCode = 1 }
  assert('valid plan passes', validatePlan([
    { x: 0, y: -60, z: 0, block: 'oak_planks' },
    { x: 1, y: -60, z: 0, block: 'oak_planks' },
  ]).ok)
  assert('garden overlap rejected', !validatePlan([{ x: 12, y: -60, z: 12, block: 'stone' }]).ok)
  assert('out of bounds rejected', !validatePlan([{ x: 0, y: -100, z: 0, block: 'stone' }]).ok)
  assert('duplicate cells rejected', !validatePlan([
    { x: 0, y: -60, z: 0, block: 'stone' },
    { x: 0, y: -60, z: 0, block: 'stone' },
  ]).ok)
  const big = Array.from({ length: 501 }, (_, i) => ({ x: i, y: -60, z: 100, block: 'stone' }))
  assert('oversized plan rejected', !validatePlan(big).ok)
  assert('colliding plans detected', !checkCollisions({
    a: [{ x: 5, y: -60, z: 5, block: 'stone' }],
    b: [{ x: 5, y: -60, z: 5, block: 'oak_planks' }],
  }).ok)
  assert('non-colliding plans pass', checkCollisions({
    a: [{ x: 5, y: -60, z: 5, block: 'stone' }],
    b: [{ x: 6, y: -60, z: 5, block: 'oak_planks' }],
  }).ok)
  console.log(process.exitCode ? 'TESTS FAILED' : 'ALL PLANNER TESTS PASSED')
}
