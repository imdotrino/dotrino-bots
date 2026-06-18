/**
 * Driver headless de Stockfish (WASM, paquete `stockfish`) para Node.
 *
 * El paquete expone el módulo WASM crudo: se le habla por `ccall('command', …)`
 * y se lee por `engine.listener`. Usamos un solo motor por proceso (un bot de
 * ajedrez = un proceso), búsquedas serializadas, hilo único y fuerza limitable
 * (Skill Level 0–20 o UCI_Elo). El binario .wasm vive en node_modules (gitignored);
 * no se vendora al repo.
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
let _enginePromise = null

function loadRawEngine () {
  if (!_enginePromise) _enginePromise = require('stockfish')()
  return _enginePromise
}

/**
 * @param {Object} [opts]
 * @param {number} [opts.skill]      Skill Level 0–20 (default 10)
 * @param {number} [opts.elo]        UCI_Elo (si se da, ignora skill)
 * @param {number} [opts.movetimeMs] tiempo de cálculo por jugada (default 600)
 */
export async function createStockfish ({ skill = 10, elo = null, movetimeMs = 600 } = {}) {
  const engine = await loadRawEngine()
  const cmd = (c) => engine.ccall('command', null, ['string'], [c])

  cmd('uci')
  cmd('setoption name Threads value 1')
  if (elo != null) {
    cmd('setoption name UCI_LimitStrength value true')
    cmd('setoption name UCI_Elo value ' + elo)
  } else {
    cmd('setoption name Skill Level value ' + Math.max(0, Math.min(20, skill)))
  }
  cmd('isready')
  cmd('ucinewgame')

  let chain = Promise.resolve()

  function searchOnce (fen) {
    return new Promise((resolve) => {
      const prev = engine.listener
      let timer = null
      engine.listener = (line) => {
        if (typeof line === 'string' && line.startsWith('bestmove')) {
          engine.listener = prev
          if (timer) clearTimeout(timer)
          resolve(line.split(' ')[1] || null)
        }
      }
      cmd('position fen ' + fen)
      cmd('go movetime ' + movetimeMs)
      timer = setTimeout(() => { engine.listener = prev; resolve(null) }, movetimeMs + 5000)
    })
  }

  return {
    movetimeMs,
    /** Serializa las búsquedas (un motor compartido por proceso). */
    bestMoveUci (fen) {
      const run = chain.then(() => searchOnce(fen))
      chain = run.catch(() => {})
      return run
    }
  }
}
