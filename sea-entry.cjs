// sea-entry.cjs — CommonJS shim embedded in godbot.exe (Node SEA runs the
// embedded main as CJS). It simply loads godbot.mjs next to the executable,
// keeping one source of truth for the launcher logic.
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const target = path.join(path.dirname(process.execPath), 'godbot.mjs')
import(pathToFileURL(target).href).catch((e) => {
  console.error('[godbot] FATAL: could not load ' + target)
  console.error(e && e.stack || e)
  process.exit(1)
})
// keep the event loop alive while the launcher works
setInterval(() => {}, 1 << 30)
