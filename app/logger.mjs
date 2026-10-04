// logger.mjs — decision log (JSONL) + live dashboard on http://localhost:3600
// Every event records WHO decided: 'llm' (Cline SDK agent), 'jev' (TypeSafe JEV),
// 'planner' (deterministic), 'verifier', 'bot', or 'system'. That distinction is
// the judging evidence for runtime integration.
import fs from 'node:fs'
import express from 'express'

const LOG_PATH = new URL('./decisions.jsonl', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const events = []

export function log(actor, type, data = {}) {
  const e = { t: new Date().toISOString(), actor, type, ...data }
  events.push(e)
  fs.appendFileSync(LOG_PATH, JSON.stringify(e) + '\n')
  return e
}

export function startDashboard(port = 3600) {
  const app = express()
  app.get('/events', (req, res) => res.json(events))
  app.get('/', (req, res) => res.send(PAGE))
  app.listen(port, () => console.log(`dashboard: http://localhost:${port}`))
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>Grounded Builder — decision log</title>
<meta http-equiv="refresh" content="3">
<style>
 body{font:14px/1.45 ui-monospace,Consolas,monospace;background:#0d1117;color:#c9d1d9;margin:0;padding:16px}
 h1{font-size:16px;color:#58a6ff} .e{border-left:3px solid #444;margin:6px 0;padding:4px 10px;white-space:pre-wrap;word-break:break-word}
 .llm{border-color:#a371f7} .jev{border-color:#d29922} .planner{border-color:#3fb950}
 .verifier{border-color:#39c5cf} .bot,.bot-chat{border-color:#8b949e} .system{border-color:#f85149}
 .a{font-weight:700;text-transform:uppercase;font-size:11px;margin-right:8px}
 .llm .a{color:#a371f7}.jev .a{color:#d29922}.planner .a{color:#3fb950}.verifier .a{color:#39c5cf}
</style>
<h1>Grounded Builder — live decision log &nbsp;<span style="color:#8b949e">LLM=purple · JEV=amber · planner=green · verifier=cyan</span></h1>
<div id="log"></div>
<script>
fetch('/events').then(r=>r.json()).then(es=>{
  document.getElementById('log').innerHTML = es.map(e=>{
    const {t,actor,type,...rest}=e
    return '<div class="e '+actor+'"><span class="a">'+actor+'</span><b>'+type+'</b> '+
      JSON.stringify(rest)+' <span style="color:#666">'+t.slice(11,19)+'</span></div>'
  }).reverse().join('')
})
</script>`
