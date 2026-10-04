// bus.mjs — the town square: chat routing, land claims, and escalation to the
// human lawgiver (@asupasuyo). The human's word is final and enforced by the bus.
import { log } from './logger.mjs'

export function createBus({ humanName = 'asupasuyo' } = {}) {
  const claims = new Map()        // plotKey -> owner
  const listeners = new Map()     // botName -> [fn(message)]
  let escalation = null           // { topic, parties, decidedBy?, ruling? }
  const waiters = []

  function registerInbox(name, fn) {
    if (!listeners.has(name)) listeners.set(name, [])
    listeners.get(name).push(fn)
  }

  const mentioned = (message) => {
    const stripped = message.toLowerCase().replace(/@[a-z]/gi, c => ' ' + c.slice(1))
    const tokens = stripped.split(/[^a-z]+/i).filter(Boolean)
    return [...listeners.keys()].filter(n => tokens.includes(n.toLowerCase()) || stripped.includes(n.toLowerCase()))
  }

  // Every chat message flows through here. Returns true if it was law (human input).
  // isBot: true when the sender is one of our villagers. Messages carry `human`
  // so minds can treat player words as law and bot gossip as flavor.
  function route(username, message, { isBot = false } = {}) {
    if (username === humanName) {
      if (escalation) {
        escalation.ruling = message
        escalation.decidedBy = username
        log('law', 'ruling', { topic: escalation.topic, ruling: message })
        const e = escalation; escalation = null
        for (const w of waiters.splice(0)) w(e)
        return true
      }
      log('law', 'human-speaks', { message })
      // deliver to bots named in the message; if nobody is named, ONE random
      // bot picks it up — otherwise all four answer every human line (spam).
      let targets = mentioned(message)
      if (!targets.length && listeners.size)
        targets = [[...listeners.keys()][Math.floor(Math.random() * listeners.size)]]
      for (const n of targets)
        listeners.get(n).forEach(fn => fn({ from: username, text: message, priority: 'human', human: true }))
      return true
    }
    // bot/player message: deliver to anyone mentioned by @name or by name.
    // Bot speech also reaches one random other villager as gossip — that is how
    // village chatter chains instead of dying in the void.
    const heard = new Set(mentioned(message))
    heard.delete(username)
    if (isBot && !heard.size) {
      const others = [...listeners.keys()].filter(n => n !== username)
      if (others.length) heard.add(others[Math.floor(Math.random() * others.length)])
    }
    for (const name of heard)
      listeners.get(name).forEach(fn => fn({ from: username, text: message, priority: isBot ? 'bot' : 'addressed', human: !isBot }))
    return false
  }

  function claim(name, plotKey, describe) {
    const owner = claims.get(plotKey)
    if (!owner || owner === name) { claims.set(plotKey, name); log('bus', 'claim-ok', { plotKey, owner: name }); return { ok: true } }
    // conflict: escalate to the human
    escalation = { topic: `plot ${plotKey}: ${name} wants it, ${owner} holds it`, parties: [name, owner] }
    log('bus', 'claim-conflict', { plotKey, claimant: name, owner })
    sayFn_all(`@asupasuyo CONFLICT: ${name} wants ${describe(plotKey)} but ${owner} holds it. Your word is law — who gets it?`)
    return { ok: false, conflict: true, owner }
  }

  let sayFn_all = () => {}
  function bindSayAll(fn) { sayFn_all = fn }

  // A mind waits for the human's ruling. Resolves with the ruling text.
  function awaitRuling(timeoutMs = 300000) {
    return new Promise(resolve => {
      const w = (e) => resolve(e.ruling)
      waiters.push(w)
      setTimeout(() => resolve(null), timeoutMs)
    })
  }

  function release(plotKey, name) {
    if (claims.get(plotKey) === name) { claims.delete(plotKey); log('bus', 'claim-released', { plotKey, by: name }) }
  }

  return { registerInbox, route, claim, release, awaitRuling, bindSayAll, claims, getEscalation: () => escalation, humanName }
}
