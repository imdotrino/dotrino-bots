/**
 * Conversión entre la representación de tablero de la app (8x8 de chars, fila 0 =
 * rank 8) y FEN (lo que consume Stockfish por UCI), y de jugada UCI → {from,to}.
 *
 * Deriva enroques desde el historial (rules.hasPieceMoved) y el objetivo de
 * captura al paso desde el último avance doble de peón.
 */
const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']

export function boardToFen (board, color, moveHistory = [], rules = null) {
  let placement = ''
  for (let r = 0; r < 8; r++) {
    let empty = 0; let rank = ''
    for (let c = 0; c < 8; c++) {
      const p = board[r][c]
      if (!p) { empty++ } else { if (empty) { rank += empty; empty = 0 } rank += p }
    }
    if (empty) rank += empty
    placement += rank + (r < 7 ? '/' : '')
  }

  const turn = color === 'white' ? 'w' : 'b'

  const moved = (row, col) => (rules?.hasPieceMoved ? rules.hasPieceMoved(moveHistory, row, col) : false)
  let cast = ''
  if (board[7][4] === 'K') {
    if (board[7][7] === 'R' && !moved(7, 4) && !moved(7, 7)) cast += 'K'
    if (board[7][0] === 'R' && !moved(7, 4) && !moved(7, 0)) cast += 'Q'
  }
  if (board[0][4] === 'k') {
    if (board[0][7] === 'r' && !moved(0, 4) && !moved(0, 7)) cast += 'k'
    if (board[0][0] === 'r' && !moved(0, 4) && !moved(0, 0)) cast += 'q'
  }
  if (!cast) cast = '-'

  let ep = '-'
  const last = moveHistory[moveHistory.length - 1]
  if (last && last.piece && last.piece.toLowerCase() === 'p' && last.from && last.to && Math.abs(last.from.row - last.to.row) === 2) {
    const midRow = (last.from.row + last.to.row) / 2
    ep = FILES[last.to.col] + (8 - midRow)
  }

  const fullmove = Math.floor(moveHistory.length / 2) + 1
  return `${placement} ${turn} ${cast} ${ep} 0 ${fullmove}`
}

/** 'e2e4' / 'e7e8q' → { from:{row,col}, to:{row,col}, promotion } */
export function uciToMove (uci) {
  if (!uci || uci.length < 4) return null
  const col = (ch) => ch.charCodeAt(0) - 97
  const row = (ch) => 8 - parseInt(ch, 10)
  return {
    from: { row: row(uci[1]), col: col(uci[0]) },
    to: { row: row(uci[3]), col: col(uci[2]) },
    promotion: uci[4] || null
  }
}
