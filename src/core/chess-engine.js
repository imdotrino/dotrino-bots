/**
 * Motor de ajedrez del bot: carga las reglas OFICIALES de la app
 * `simple-websocket-chess` y elige jugada con BÚSQUEDA real (minimax + poda
 * alfa-beta + evaluación material/posicional, profundización iterativa con
 * presupuesto de tiempo).
 *
 * 100% programático: NO usa el LLM (el ajedrez se resuelve con búsqueda). No
 * reimplementa reglas: reusa `chessRules.js` (getValidMoves/applyMove/
 * isKingInCheck/...) vía import dinámico. Fuerza ajustable por profundidad.
 *
 * Ubicación de la app configurable con CHESS_APP_DIR (default: hermana del repo).
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { REPO_ROOT } from './env.js'

let _cache = null

export async function loadChessEngine () {
  if (_cache) return _cache
  const appDir = process.env.CHESS_APP_DIR || path.resolve(REPO_ROOT, '..', 'simple-websocket-chess')
  const rules = await import(pathToFileURL(path.join(appDir, 'src/utils/chessRules.js')).href)
  const { makeChessEngine } = await import(pathToFileURL(path.join(appDir, 'src/game/chessAdapter.js')).href)
  _cache = { rules, makeChessEngine, appDir }
  return _cache
}

// ----- evaluación -----

const VAL = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 }
const isWhitePiece = (piece) => piece === piece.toUpperCase()

// Piece-square tables (perspectiva de las BLANCAS, fila 0 = rank 8 ... fila 7 =
// rank 1). Para las negras se espeja verticalmente. Valores en centipeones.
const PST = {
  p: [
    [0, 0, 0, 0, 0, 0, 0, 0],
    [50, 50, 50, 50, 50, 50, 50, 50],
    [10, 10, 20, 30, 30, 20, 10, 10],
    [5, 5, 10, 25, 25, 10, 5, 5],
    [0, 0, 0, 20, 20, 0, 0, 0],
    [5, -5, -10, 0, 0, -10, -5, 5],
    [5, 10, 10, -20, -20, 10, 10, 5],
    [0, 0, 0, 0, 0, 0, 0, 0]
  ],
  n: [
    [-50, -40, -30, -30, -30, -30, -40, -50],
    [-40, -20, 0, 0, 0, 0, -20, -40],
    [-30, 0, 10, 15, 15, 10, 0, -30],
    [-30, 5, 15, 20, 20, 15, 5, -30],
    [-30, 0, 15, 20, 20, 15, 0, -30],
    [-30, 5, 10, 15, 15, 10, 5, -30],
    [-40, -20, 0, 5, 5, 0, -20, -40],
    [-50, -40, -30, -30, -30, -30, -40, -50]
  ],
  b: [
    [-20, -10, -10, -10, -10, -10, -10, -20],
    [-10, 0, 0, 0, 0, 0, 0, -10],
    [-10, 0, 5, 10, 10, 5, 0, -10],
    [-10, 5, 5, 10, 10, 5, 5, -10],
    [-10, 0, 10, 10, 10, 10, 0, -10],
    [-10, 10, 10, 10, 10, 10, 10, -10],
    [-10, 5, 0, 0, 0, 0, 5, -10],
    [-20, -10, -10, -10, -10, -10, -10, -20]
  ],
  r: [
    [0, 0, 0, 0, 0, 0, 0, 0],
    [5, 10, 10, 10, 10, 10, 10, 5],
    [-5, 0, 0, 0, 0, 0, 0, -5],
    [-5, 0, 0, 0, 0, 0, 0, -5],
    [-5, 0, 0, 0, 0, 0, 0, -5],
    [-5, 0, 0, 0, 0, 0, 0, -5],
    [-5, 0, 0, 0, 0, 0, 0, -5],
    [0, 0, 0, 5, 5, 0, 0, 0]
  ],
  q: [
    [-20, -10, -10, -5, -5, -10, -10, -20],
    [-10, 0, 0, 0, 0, 0, 0, -10],
    [-10, 0, 5, 5, 5, 5, 0, -10],
    [-5, 0, 5, 5, 5, 5, 0, -5],
    [0, 0, 5, 5, 5, 5, 0, -5],
    [-10, 5, 5, 5, 5, 5, 0, -10],
    [-10, 0, 5, 0, 0, 0, 0, -10],
    [-20, -10, -10, -5, -5, -10, -10, -20]
  ],
  k: [
    [-30, -40, -40, -50, -50, -40, -40, -30],
    [-30, -40, -40, -50, -50, -40, -40, -30],
    [-30, -40, -40, -50, -50, -40, -40, -30],
    [-30, -40, -40, -50, -50, -40, -40, -30],
    [-20, -30, -30, -40, -40, -30, -30, -20],
    [-10, -20, -20, -20, -20, -20, -20, -10],
    [20, 20, 0, 0, 0, 0, 20, 20],
    [20, 30, 10, 0, 0, 10, 30, 20]
  ]
}

/** Evaluación estática en centipeones, desde la perspectiva de las BLANCAS. */
function evaluate (board) {
  let score = 0
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const piece = board[r][c]
      if (!piece) continue
      const t = piece.toLowerCase()
      const base = VAL[t] || 0
      if (isWhitePiece(piece)) {
        score += base + (PST[t] ? PST[t][r][c] : 0)
      } else {
        score -= base + (PST[t] ? PST[t][7 - r][c] : 0) // espejo vertical para negras
      }
    }
  }
  return score
}

// ----- generación / orden de jugadas -----

const val = (piece) => (piece ? (VAL[piece.toLowerCase()] || 0) : 0)

export function legalMoves (rules, board, color, moveHistory = []) {
  const out = []
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const piece = board[r][c]
      if (!piece) continue
      if ((color === 'white') !== isWhitePiece(piece)) continue
      const dests = rules.getValidMoves(board, r, c, piece, moveHistory) || []
      for (const d of dests) {
        out.push({ from: { row: r, col: c }, to: { row: d.row, col: d.col }, piece, captured: board[d.row][d.col] || '' })
      }
    }
  }
  return out
}

/** Jugadas ordenadas: capturas primero (MVV-LVA) para mejor poda alfa-beta. */
function orderedMoves (rules, board, color, mh) {
  const moves = legalMoves(rules, board, color, mh)
  moves.sort((a, b) => (val(b.captured) - val(b.piece) / 10) - (val(a.captured) - val(a.piece) / 10))
  return moves
}

const MATE = 1000000
const other = (c) => (c === 'white' ? 'black' : 'white')
const sign = (c) => (c === 'white' ? 1 : -1)

// Negamax con poda alfa-beta. Devuelve el valor desde la perspectiva de `color`.
function negamax (rules, board, color, depth, alpha, beta, ply, deadline) {
  if (Date.now() > deadline) return sign(color) * evaluate(board)
  const moves = orderedMoves(rules, board, color, [])
  if (moves.length === 0) {
    if (rules.isKingInCheck(board, color)) return -MATE + ply // jaque mate (preferir el más cercano)
    return 0 // tablas por ahogado
  }
  if (depth === 0) return sign(color) * evaluate(board)
  let best = -Infinity
  for (const m of moves) {
    const nb = rules.applyMove(board, m.from.row, m.from.col, m.to.row, m.to.col)
    const score = -negamax(rules, nb, other(color), depth - 1, -beta, -alpha, ply + 1, deadline)
    if (score > best) best = score
    if (best > alpha) alpha = best
    if (alpha >= beta) break // poda
  }
  return best
}

/**
 * Elige la mejor jugada con profundización iterativa hasta `maxDepth` o agotar
 * `timeBudgetMs`. Entre jugadas casi-iguales (margen) elige al azar para variar.
 * @returns {{from,to,piece,captured}|null}
 */
export function chooseMove (rules, board, color, moveHistory = [], opts = {}) {
  const maxDepth = opts.maxDepth || 3
  const timeBudgetMs = opts.timeBudgetMs || 2500
  const margin = opts.margin ?? 20
  const moves = orderedMoves(rules, board, color, moveHistory)
  if (moves.length === 0) return null
  if (moves.length === 1) return moves[0]

  const deadline = Date.now() + timeBudgetMs
  let bestMove = moves[0]
  let scored = moves.map(m => ({ m, s: 0 }))

  for (let depth = 1; depth <= maxDepth; depth++) {
    let alpha = -Infinity
    const results = []
    let aborted = false
    // Probar primero la mejor de la iteración previa (mejora la poda).
    const order = [bestMove, ...moves.filter(m => m !== bestMove)]
    for (const m of order) {
      if (Date.now() > deadline) { aborted = true; break }
      const nb = rules.applyMove(board, m.from.row, m.from.col, m.to.row, m.to.col)
      const s = -negamax(rules, nb, other(color), depth - 1, -Infinity, -alpha, 1, deadline)
      results.push({ m, s })
      if (s > alpha) alpha = s
    }
    if (!aborted && results.length) {
      results.sort((a, b) => b.s - a.s)
      scored = results
      bestMove = results[0].m
    }
    if (aborted) break
  }

  // Variedad: elegir al azar entre las jugadas dentro del margen de la mejor.
  const top = scored[0].s
  const pool = scored.filter(x => top - x.s <= margin).map(x => x.m)
  return pool[Math.floor(Math.random() * pool.length)] || bestMove
}

/**
 * Motor "greedy" de 1 jugada (la primera implementación): jaque mate inmediato >
 * captura de mayor valor > da jaque > aleatorio. Débil pero rápido y variado.
 */
export function greedyMove (rules, board, color, moveHistory = []) {
  const moves = legalMoves(rules, board, color, moveHistory)
  if (!moves.length) return null
  const opp = other(color)
  for (const m of moves) {
    try {
      const nb = rules.applyMove(board, m.from.row, m.from.col, m.to.row, m.to.col)
      if (rules.isCheckmate(nb, opp, moveHistory)) return m
    } catch (_) {}
  }
  let best = []; let bestScore = -Infinity
  for (const m of moves) {
    let s = (m.captured ? (VAL[m.captured.toLowerCase()] || 0) : 0) * 10
    try {
      const nb = rules.applyMove(board, m.from.row, m.from.col, m.to.row, m.to.col)
      if (rules.isKingInCheck(nb, opp)) s += 50
    } catch (_) {}
    s += Math.random() * 30
    if (s > bestScore) { bestScore = s; best = [m] } else if (s === bestScore) best.push(m)
  }
  return best[Math.floor(Math.random() * best.length)]
}

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
export const coord = (sq) => (sq ? `${FILES[sq.col]}${8 - sq.row}` : '?')
/** UCI de una jugada: {from,to} → 'e2e4'. */
export const moveUci = (m) => coord(m.from) + coord(m.to)
