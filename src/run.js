#!/usr/bin/env node
/**
 * Runner de la colección de bots de Dotrino.
 *
 * Levanta N bots, cada uno en su propio proceso (fork) → cada bot es un usuario
 * distinto con identidad y transporte aislados. Los bots simulan actividad real
 * en las apps del ecosistema sin tocar el front (no afectan GoatCounter).
 *
 * Uso:
 *   node src/run.js --app chat --room general --count 3
 *   node src/run.js --app chat --room demo --names Lucia,Mateo
 *
 * Opciones:
 *   --app <nombre>     app objetivo (default: chat)
 *   --room <sala>      sala de chat (default: general)
 *   --count <n>        cuántos bots (default: 2)
 *   --names a,b,c      nombres explícitos (override de --count y del pool)
 */
import { fork } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { personaFor, PERSONAS } from './core/personas.js'
import { REPO_ROOT, DEEPSEEK_API_KEY } from './core/env.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function parseArgs (argv) {
  const a = { app: 'chat', room: 'general', count: 2, names: null }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    const v = argv[i + 1]
    if (k === '--app') { a.app = v; i++ }
    else if (k === '--room') { a.room = v; i++ }
    else if (k === '--count') { a.count = parseInt(v, 10) || 1; i++ }
    else if (k === '--names') { a.names = v.split(',').map(s => s.trim()).filter(Boolean); i++ }
    else if (k === '--role') { a.role = v; i++ }       // cuarenta: host | filler
    else if (k === '--size') { a.size = v; i++ }        // cuarenta: 2 | 4
    else if (k === '--engine') { a.engine = v; i++ }    // cuarenta: heuristic:N
  }
  return a
}

function resolveBots (args) {
  if (args.names) {
    return args.names.map((name, i) => {
      const known = PERSONAS.find(p => p.name.toLowerCase() === name.toLowerCase())
      return { name, persona: known?.persona || `${name}, una persona conversadora y amable` }
    })
  }
  return Array.from({ length: args.count }, (_, i) => personaFor(i))
}

function main () {
  const args = parseArgs(process.argv.slice(2))
  const bots = resolveBots(args)

  console.log(`Dotrino bots — app=${args.app} room=#${args.room} bots=${bots.length}`)
  if (!DEEPSEEK_API_KEY) console.log('⚠ DEEPSEEK_API_KEY no encontrada: los bots usarán respuestas de reserva.')

  const children = []
  bots.forEach((b, i) => {
    const dir = path.join(REPO_ROOT, 'identities', args.app, b.name.toLowerCase())
    const child = fork(path.join(__dirname, 'bot-process.js'), [], {
      env: {
        ...process.env,
        BOT_DIR: dir,
        BOT_NAME: b.name,
        BOT_PERSONA: b.persona,
        BOT_APP: args.app,
        BOT_ROOM: args.room,
        ...(args.app === 'cuarenta'
          ? { BOT_ROLE: args.role || 'host', BOT_TABLE_SIZE: String(args.size || 2), BOT_CUARENTA_ENGINE: args.engine || 'heuristic:2' }
          : {})
      },
      stdio: 'inherit'
    })
    children.push(child)
    child.on('exit', (code) => console.log(`bot ${b.name} terminó (code ${code})`))
  })

  const shutdown = () => {
    console.log('\nDeteniendo bots…')
    for (const c of children) { try { c.kill('SIGTERM') } catch (_) {} }
    setTimeout(() => process.exit(0), 1500)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main()
