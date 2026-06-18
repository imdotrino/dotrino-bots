#!/usr/bin/env node
/**
 * Generador de la flota de bots para PM2.
 *
 * Escribe `bots.config.json` (la definición de la flota) que lee
 * `ecosystem.config.cjs`. Reusa el pool de personas para que cada nombre tenga
 * su personaje estable y su directorio de identidad fijo.
 *
 * Uso:
 *   node src/gen-ecosystem.js --app chat --room general --count 3
 *   node src/gen-ecosystem.js --app chat --room demo --names Lucia,Mateo
 *   node src/gen-ecosystem.js --app chat --room sala2 --count 2 --append
 *   node src/gen-ecosystem.js --app cuarenta --tables2 2 --tables4 1
 *
 * Luego: npx pm2 start ecosystem.config.cjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { personaFor, PERSONAS } from './core/personas.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const CONFIG = path.join(ROOT, 'bots.config.json')

function parseArgs (argv) {
  const a = { app: 'chat', room: 'general', count: null, names: null, append: false }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1]
    if (k === '--app') { a.app = v; i++ }
    else if (k === '--room') { a.room = v; i++ }
    else if (k === '--count') { a.count = parseInt(v, 10) || 1; i++ }
    else if (k === '--names') { a.names = v.split(',').map(s => s.trim()).filter(Boolean); i++ }
    else if (k === '--engines') { a.engines = v.split(',').map(s => s.trim()).filter(Boolean); i++ }
    else if (k === '--tables2') { a.tables2 = parseInt(v, 10) || 0; i++ } // cuarenta: nº de mesas de 2
    else if (k === '--tables4') { a.tables4 = parseInt(v, 10) || 0; i++ } // cuarenta: nº de mesas de 4
    else if (k === '--engine') { a.engine = v; i++ }                     // cuarenta: heuristic:N
    else if (k === '--append') { a.append = true }
  }
  return a
}

// Motores variados para que cada bot de ajedrez juegue distinto.
const CHESS_ENGINES = ['stockfish:6', 'minimax:3', 'greedy', 'llm']
// Nombre alusivo al motor (lo que verá el rival en la sala).
const ENGINE_NAME = { stockfish: 'Stockfish', minimax: 'Minimax', greedy: 'Goloso', llm: 'Neuronal' }
const nameForEngine = (engine) => ENGINE_NAME[String(engine).split(/[:#]/)[0]] || engine

function personaText (name, i) {
  const known = PERSONAS.find(p => p.name.toLowerCase() === name.toLowerCase())
  return known?.persona || `${name}, una persona conversadora y amable`
}

// Nombre estable y ÚNICO del pool (cada nombre = un dir de identidad propio).
function uniqueNames (n, seen) {
  const out = []
  for (let i = 0; out.length < n; i++) {
    let name = personaFor(i).name
    if (seen.has(name.toLowerCase())) { let k = 2; while (seen.has(`${name}${k}`.toLowerCase())) k++; name = `${name}${k}` }
    seen.add(name.toLowerCase())
    out.push(name)
  }
  return out
}

function buildBots (args) {
  // Cuarenta: mesas de 2 (1 host c/u) y mesas de 4 (1 host + 2 fillers c/u). Cada
  // bot es un usuario independiente (1 identidad = 1 asiento). Las mesas de bots
  // sólo arrancan cuando se sienta un humano (ver cuarenta-bot.js).
  if (args.app === 'cuarenta') {
    const engine = args.engine || 'heuristic:2'
    const n2 = args.tables2 != null ? args.tables2 : 2
    const n4 = args.tables4 != null ? args.tables4 : 1
    const seen = new Set()
    const out = []
    for (const name of uniqueNames(n2, seen)) {
      out.push({ name, persona: `${name}, jugador de cuarenta`, app: 'cuarenta', room: args.room, role: 'host', size: 2, engine })
    }
    for (let t = 0; t < n4; t++) {
      const [host, f1, f2] = uniqueNames(3, seen)
      out.push({ name: host, persona: `${host}, anfitrión de cuarenta (mesa de 4)`, app: 'cuarenta', room: args.room, role: 'host', size: 4, engine })
      out.push({ name: f1, persona: `${f1}, jugador de cuarenta`, app: 'cuarenta', room: args.room, role: 'filler', size: 4, engine })
      out.push({ name: f2, persona: `${f2}, jugador de cuarenta`, app: 'cuarenta', room: args.room, role: 'filler', size: 4, engine })
    }
    return out
  }

  // Ajedrez: un bot por motor, con nombre alusivo al motor (no usa el pool).
  if (args.app === 'chess') {
    let engines
    if (args.engines) engines = args.engines
    else if (args.count) engines = Array.from({ length: args.count }, (_, i) => CHESS_ENGINES[i % CHESS_ENGINES.length])
    else engines = [...CHESS_ENGINES]
    const seen = {}
    return engines.map((engine) => {
      const base = nameForEngine(engine)
      seen[base] = (seen[base] || 0) + 1
      const name = seen[base] > 1 ? `${base}${seen[base]}` : base
      return { name, persona: `${name}, ajedrecista (motor ${engine})`, app: 'chess', room: args.room, engine }
    })
  }
  const names = args.names || Array.from({ length: args.count || 2 }, (_, i) => personaFor(i).name)
  return names.map((name, i) => ({ name, persona: personaText(name, i), app: args.app, room: args.room }))
}

function main () {
  const args = parseArgs(process.argv.slice(2))
  let fleet = buildBots(args)

  if (args.append && fs.existsSync(CONFIG)) {
    try {
      const prev = JSON.parse(fs.readFileSync(CONFIG, 'utf8'))
      // Dedup por app+room+name (la identidad de un proceso PM2).
      const key = b => `${b.app}/${b.room}/${b.name.toLowerCase()}`
      const seen = new Set(prev.map(key))
      fleet = [...prev, ...fleet.filter(b => !seen.has(key(b)))]
    } catch (_) {}
  }

  fs.writeFileSync(CONFIG, JSON.stringify(fleet, null, 2) + '\n')
  console.log(`bots.config.json: ${fleet.length} bot(s)`)
  for (const b of fleet) {
    const detail = b.app === 'chess' ? 'motor ' + b.engine
      : b.app === 'cuarenta' ? `${b.role} mesa${b.size} (${b.engine})`
        : '#' + b.room
    console.log(`  ccbot-${b.app}-${b.name.toLowerCase()}  →  ${detail}`)
  }
  console.log('\nArrancar:  npx pm2 start ecosystem.config.cjs')
}

main()
