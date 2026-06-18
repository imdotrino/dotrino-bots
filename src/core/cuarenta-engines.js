/**
 * Fábrica de "motores" (estrategias) del bot de Cuarenta. Análogo a
 * `chess-engines.js`: dado un spec (`heuristic:N`) devuelve un objeto con
 * `play(rules, view) → { card, captured }` (jugada del turno) y
 * `rob(rules, view) → { captured } | null` (robo en la ventana de claim).
 * Todo programático (sin LLM). Niveles: 1 fácil, 2 normal, 3 difícil.
 */
import { choosePlay, chooseRob, chooseCarryRob, chooseCut } from './cuarenta-engine.js'

export function createCuarentaEngine (spec = 'heuristic:2') {
  const lvl = parseInt(String(spec).split(':')[1], 10)
  const level = Math.max(1, Math.min(3, Number.isFinite(lvl) ? lvl : 2))
  return {
    name: `heuristic:${level}`,
    level,
    async play (rules, view) { return choosePlay(rules, view, { level }) },
    async rob (rules, view) { return chooseRob(rules, view) },
    async carryRob (rules, view) { return chooseCarryRob(rules, view) },
    async cut (rules, view) { return chooseCut(rules, view) }
  }
}
