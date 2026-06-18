/**
 * Fábrica de "motores" de ajedrez para los bots. Cada motor expone la misma
 * interfaz —`async bestMove(rules, board, color, moveHistory)`— y cada bot puede
 * usar uno distinto, así juegan diferente. Spec (BOT_CHESS_ENGINE):
 *
 *   stockfish        Stockfish skill 10
 *   stockfish:5      Stockfish Skill Level 5 (0–20)
 *   stockfish#1350   Stockfish limitado a 1350 Elo
 *   minimax          minimax alfa-beta profundidad 3 (mío)
 *   minimax:2        minimax profundidad 2
 *   greedy           heurística de 1 jugada (la primera)
 *   llm              DeepSeek elige entre las jugadas LEGALES (la "IA")
 *
 * Todos eligen SIEMPRE jugadas legales (los no-stockfish generan la lista con las
 * reglas; el llm elige de esa lista; stockfish se valida y cae a minimax si su
 * jugada no fuese legal en el estado de la app).
 */
import { chooseMove as minimaxMove, greedyMove, legalMoves, moveUci, coord } from './chess-engine.js'
import { boardToFen, uciToMove } from './chess-fen.js'
import { createStockfish } from './chess-stockfish.js'
import { Brain } from './brain.js'

function toMove (board, from, to) {
  const piece = board[from.row]?.[from.col] || ''
  const captured = board[to.row]?.[to.col] || ''
  return { from, to, piece, captured }
}

function isLegal (rules, board, from, to, mh) {
  const piece = board[from.row]?.[from.col]
  if (!piece) return false
  const dests = rules.getValidMoves(board, from.row, from.col, piece, mh) || []
  return dests.some(d => d.row === to.row && d.col === to.col)
}

function minimaxEngine (depth) {
  return {
    name: `minimax:${depth}`,
    async bestMove (rules, board, color, mh) { return minimaxMove(rules, board, color, mh, { maxDepth: depth }) }
  }
}

function greedyEngine () {
  return {
    name: 'greedy',
    async bestMove (rules, board, color, mh) { return greedyMove(rules, board, color, mh) }
  }
}

function stockfishEngine ({ skill, elo, movetimeMs }) {
  let sfPromise = null
  const getSf = () => {
    if (!sfPromise) sfPromise = createStockfish({ skill, elo, movetimeMs })
    return sfPromise
  }
  return {
    name: elo != null ? `stockfish#${elo}` : `stockfish:${skill}`,
    async bestMove (rules, board, color, mh) {
      try {
        const sf = await getSf()
        const fen = boardToFen(board, color, mh, rules)
        const uci = await sf.bestMoveUci(fen)
        if (uci && uci !== '(none)') {
          const mv = uciToMove(uci)
          if (mv && isLegal(rules, board, mv.from, mv.to, mh)) return toMove(board, mv.from, mv.to)
        }
      } catch (_) { /* cae a minimax */ }
      return minimaxMove(rules, board, color, mh, { maxDepth: 2 }) // fallback robusto
    }
  }
}

function llmEngine (persona) {
  const brain = new Brain({ persona: persona || 'un ajedrecista casual y conversador' })
  return {
    name: 'llm',
    async bestMove (rules, board, color, mh) {
      const moves = legalMoves(rules, board, color, mh)
      if (!moves.length) return null
      const ucis = moves.map(moveUci)
      const fen = boardToFen(board, color, mh, rules)
      const q = `Juegas al ajedrez con las ${color === 'white' ? 'blancas' : 'negras'}. Posición (FEN): ${fen}. Elige TU mejor jugada de la lista (formato origen-destino, ej. e2e4).`
      let pick
      try { pick = await brain.decide(q, ucis) } catch (_) { pick = null }
      const chosen = moves.find(m => moveUci(m) === pick) || moves[Math.floor(Math.random() * moves.length)]
      return chosen
    }
  }
}

export function createChessEngine (spec = 'minimax:3', { persona = '' } = {}) {
  const s = String(spec || 'minimax:3').trim()
  const eloMatch = s.match(/^stockfish#(\d+)$/)
  if (eloMatch) return stockfishEngine({ elo: parseInt(eloMatch[1], 10), movetimeMs: 700 })
  const [kind, arg] = s.split(':')
  switch (kind) {
    case 'stockfish': return stockfishEngine({ skill: arg != null ? parseInt(arg, 10) : 10, movetimeMs: 600 })
    case 'minimax': return minimaxEngine(arg ? parseInt(arg, 10) || 3 : 3)
    case 'greedy': return greedyEngine()
    case 'llm': return llmEngine(persona)
    default: return minimaxEngine(3)
  }
}

export { coord }
