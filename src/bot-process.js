/**
 * Proceso de UN bot. Lo lanza el runner (`run.js`) con fork(), un proceso por
 * bot, para aislar por completo la identidad, el keypair de transporte y los
 * singletons de módulo (cada bot es un "usuario" independiente).
 *
 * Config por variables de entorno:
 *   BOT_DIR     directorio de persistencia de la identidad del bot (obligatorio)
 *   BOT_NAME    nickname del bot
 *   BOT_PERSONA descripción de personaje para el cerebro DeepSeek (chat)
 *   BOT_APP     app objetivo ('chat' | 'chess' | 'cuarenta')
 *   BOT_ROOM    sala (para chat)
 *   BOT_TOPICS  categorías de feed CSV (chat); vacío = todas
 *   BOT_ROLE    cuarenta: 'host' | 'filler' (default host)
 *   BOT_TABLE_SIZE   cuarenta: 2 | 4 (default 2)
 *   BOT_CUARENTA_ENGINE  cuarenta: 'heuristic:N' (default heuristic:2)
 */
import path from 'node:path'
import { Identity } from '@dotrino/identity/node'

const {
  BOT_DIR, BOT_NAME = 'bot', BOT_PERSONA = '', BOT_APP = 'chat', BOT_ROOM = 'general',
  BOT_TOPICS = ''
} = process.env

const stamp = () => new Date().toISOString().slice(11, 19)
const log = (...a) => console.log(stamp(), ...a)

async function buildChat (identity) {
  const { createTransport } = await import('./core/transport.js')
  const { Brain } = await import('./core/brain.js')
  const { TopicFeed, ALL_CATEGORIES } = await import('./core/topics.js')
  const { ChatBot } = await import('./bots/chat-bot.js')
  const transport = await createTransport({ identity, dir: BOT_DIR })
  const brain = new Brain({ persona: BOT_PERSONA })
  const categories = BOT_TOPICS ? BOT_TOPICS.split(',').map(s => s.trim()).filter(Boolean) : ALL_CATEGORIES
  const topics = new TopicFeed({ categories })
  return new ChatBot({ identity, transport, brain, topics, registryDir: path.dirname(BOT_DIR), nickname: BOT_NAME, room: BOT_ROOM, log })
}

async function buildChess (identity) {
  const { installNodeGlobals } = await import('./core/node-globals.js')
  installNodeGlobals(BOT_DIR)
  const { getWebSocketProxyClient } = await import('@dotrino/proxy-client')
  const { createLobby, discoveryChannel, roomChannel } = await import('@dotrino/lobby')
  const { loadChessEngine } = await import('./core/chess-engine.js')
  const { createChessEngine } = await import('./core/chess-engines.js')
  const { ChessBot } = await import('./bots/chess-bot.js')
  const { PROXY_URL } = await import('./core/env.js')

  const { rules, makeChessEngine } = await loadChessEngine()
  const engine = makeChessEngine({ ...rules }) // motor de reglas que corre el lobby (host)
  const strategy = createChessEngine(process.env.BOT_CHESS_ENGINE || 'minimax:3', { persona: BOT_PERSONA })
  const proxy = getWebSocketProxyClient({
    url: PROXY_URL, enableWebRTC: false, autoReconnect: true,
    maxReconnectAttempts: 100000, reconnectDelay: 4000
  })
  const lobby = await createLobby({
    gameId: 'chess', seats: ['white', 'black'], engine, proxy, identity,
    start: 'full', onSeatVacated: 'pause', playerName: BOT_NAME
  })
  log(`motor de ajedrez: ${strategy.name}`)
  return new ChessBot({ lobby, identity, engineRules: rules, engine: strategy, discoveryChannel, roomChannel, registryDir: path.dirname(BOT_DIR), nickname: BOT_NAME, log })
}

async function buildCuarenta (identity) {
  const { installNodeGlobals } = await import('./core/node-globals.js')
  installNodeGlobals(BOT_DIR)
  const { getWebSocketProxyClient } = await import('@dotrino/proxy-client')
  const { createLobby, discoveryChannel, roomChannel } = await import('@dotrino/lobby')
  const { loadCuarentaEngine } = await import('./core/cuarenta-engine.js')
  const { createCuarentaEngine } = await import('./core/cuarenta-engines.js')
  const { CuarentaBot } = await import('./bots/cuarenta-bot.js')
  const { PROXY_URL } = await import('./core/env.js')

  const role = process.env.BOT_ROLE === 'filler' ? 'filler' : 'host'
  const tableSize = parseInt(process.env.BOT_TABLE_SIZE, 10) === 4 ? 4 : 2

  const { rules, makeCuarentaEngine, setPendingConfig } = await loadCuarentaEngine()
  const engine = makeCuarentaEngine() // motor de reglas que corre el host del lobby
  const strategy = createCuarentaEngine(process.env.BOT_CUARENTA_ENGINE || 'heuristic:2')
  const proxy = getWebSocketProxyClient({
    url: PROXY_URL, enableWebRTC: false, autoReconnect: true,
    maxReconnectAttempts: 100000, reconnectDelay: 4000
  })
  // El host fija el tamaño con sus asientos (2 ó 4); el filler usa 4 y adopta los del host.
  const seats = (role === 'host' && tableSize === 2) ? ['p1', 'p2'] : ['p1', 'p2', 'p3', 'p4']
  const lobby = await createLobby({
    gameId: 'cuarenta', seats, engine, proxy, identity,
    start: 'manual', onSeatVacated: 'pause', allowSpectators: true, playerName: BOT_NAME
  })
  log(`cuarenta ${role} mesa${tableSize}, motor ${strategy.name}`)
  return new CuarentaBot({
    lobby, identity, rules, engine: strategy, setPendingConfig, discoveryChannel, roomChannel,
    role, tableSize, registryDir: path.dirname(BOT_DIR), nickname: BOT_NAME, log
  })
}

async function main () {
  if (!BOT_DIR) throw new Error('BOT_DIR requerido')
  const identity = await Identity.connect({ dir: BOT_DIR })

  let bot
  switch (BOT_APP) {
    case 'chat': bot = await buildChat(identity); break
    case 'chess': bot = await buildChess(identity); break
    case 'cuarenta': bot = await buildCuarenta(identity); break
    default: throw new Error(`App no soportada todavía: ${BOT_APP}`)
  }

  await bot.start()
  log(`bot "${BOT_NAME}" activo en ${BOT_APP}`)

  const shutdown = async () => { try { await bot.stop() } catch (_) {}; process.exit(0) }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch(e => { console.error('bot fatal:', e); process.exit(1) })
