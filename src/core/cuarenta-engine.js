/**
 * Motor del bot de Cuarenta (40): carga las reglas y el motor OFICIALES de la app
 * `cuarenta` y decide la jugada con una heurística programática. NO usa el LLM.
 *
 * Reglas vigentes (captura MANUAL): al tirar una carta, el jugador SELECCIONA las
 * cartas de la mesa que levanta. Un levante es una escalera contigua que arranca
 * en el `seq` de la carta tirada y sube de a uno; cada peldaño se cubre con una
 * carta de ese `seq` o (numéricos ≤7) con una pareja de numéricas que sumen el
 * peldaño. Si tiras una carta que PODÍA levantar y no seleccionás, se abre una
 * ventana de "robar" (cualquiera la toma); seleccionar una combinación inválida es
 * falta (+10 al rival). Además, tras un levante que deja colgando la CONTINUACIÓN de
 * la escalera (hay en la mesa una carta del valor siguiente al tope levantado) se
 * abre un "carry": cualquiera roba esa continuación (escalera desde ese valor, sólo
 * cartas de la mesa, sin carta resultado) hasta que el siguiente juegue; encadena
 * (6, luego 7…). Por eso el bot: (1) en su turno captura cuando puede (prefiriendo
 * no dejar carry) y, si sólo puede botar, evita abrir ventana de robo; (2) roba la
 * caída (claim) y la continuación (carry) cuando puede: cartón gratis. Nunca
 * selecciona una combinación inválida (sería falta).
 *
 * No reimplementa reglas: reusa `cuarentaRules.js` (isValidCapture/captureExists/…)
 * y `cuarentaEngine.js` (makeCuarentaEngine/setPendingConfig) vía import dinámico.
 * El motor autoritativo sólo lo corre el HOST; los demás reflejan su `view`.
 *
 * Ubicación de la app configurable con CUARENTA_APP_DIR (default: hermana del repo).
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { REPO_ROOT } from './env.js'

let _cache = null

export async function loadCuarentaEngine () {
  if (_cache) return _cache
  const appDir = process.env.CUARENTA_APP_DIR || path.resolve(REPO_ROOT, '..', 'cuarenta')
  const engineMod = await import(pathToFileURL(path.join(appDir, 'src/game/cuarentaEngine.js')).href)
  const rules = await import(pathToFileURL(path.join(appDir, 'src/game/cuarentaRules.js')).href)
  _cache = {
    rules,
    makeCuarentaEngine: engineMod.makeCuarentaEngine,
    setPendingConfig: engineMod.setPendingConfig,
    appDir
  }
  return _cache
}

// ───────────────────────── búsqueda de captura ──────────────────────────────
// Un peldaño de valor `v` se cubre con UNA carta de seq===v, o —SÓLO en la BASE de
// la escalera— con una pareja de numéricas (sum≠null) que sumen v. Los peldaños por
// ENCIMA de la base van siempre con cartas sueltas: la suma NO sube peldaños (igual
// que `fillsRun` en cuarentaRules.js). Antes esto permitía sumas en cualquier
// peldaño → capturas ILEGALES como "tiro un 4 y me llevo 2,3,4 cubriendo el 5 con
// 2+3", que el motor autoritativo rechaza como falta (+10 al rival).
function coverWays (table, v, atBase) {
  const ways = []
  for (const c of table) if (c.seq === v) ways.push([c])
  if (atBase && v <= 7) {
    const nums = table.filter(c => c.sum != null)
    for (let i = 0; i < nums.length; i++) {
      for (let j = i + 1; j < nums.length; j++) {
        if (nums[i].sum + nums[j].sum === v) ways.push([nums[i], nums[j]])
      }
    }
  }
  return ways
}

// Captura de MÁS cartas en una escalera contigua que arranca en `v` (se puede
// parar en cualquier peldaño). `v` aquí es SIEMPRE un peldaño por encima de la base
// → sin sumas. Devuelve el array de cartas (o [] si no sigue).
function bestFrom (table, v) {
  let best = []
  for (const way of coverWays(table, v, false)) {
    const ids = new Set(way.map(c => c.id))
    const rest = table.filter(c => !ids.has(c.id))
    const cand = way.concat(bestFrom(rest, v + 1))
    if (cand.length > best.length) best = cand
  }
  return best
}

/**
 * Mejor captura (máx cartas) para `played` sobre `table`. `excludeId` quita una
 * carta del pool (p.ej. la propia carta tirada durante la ventana de robo).
 * Devuelve array de cartas a levantar, o null si no se puede cubrir la base.
 * La BASE (played.seq) admite suma de 2; los peldaños superiores no.
 */
export function bestCapture (table, played, excludeId = null) {
  const pool = excludeId ? table.filter(c => c.id !== excludeId) : table
  let best = null
  for (const way of coverWays(pool, played.seq, true)) {
    const ids = new Set(way.map(c => c.id))
    const rest = pool.filter(c => !ids.has(c.id))
    const cand = way.concat(bestFrom(rest, played.seq + 1))
    if (!best || cand.length > best.length) best = cand
  }
  return best
}

// ───────────────────────── heurística de jugada ─────────────────────────────

/** Evalúa tirar `card` en mi turno: capturar (selección) o botar. */
export function evaluatePlay (rules, view, card) {
  const table = view.table || []
  const cap = bestCapture(table, card)
  // Sanidad: el motor rechaza una combinación inválida como FALTA (+10 al rival);
  // sólo capturamos si las reglas oficiales la validan.
  if (cap && cap.length && rules.isValidCapture(card, cap)) {
    const capIds = new Set(cap.map(c => c.id))
    const lastPlay = view.lastPlay
    const caida = !!(lastPlay && lastPlay.card.r === card.r && capIds.has(lastPlay.card.id))
    const leftover = table.filter(c => !capIds.has(c.id))
    const limpia = leftover.length === 0
    const cards = cap.length + 1 // levantadas + la tirada
    const pts = (caida ? 2 : 0) + (limpia ? 2 : 0)
    // ¿deja la continuación colgando? (abre carry → me lo pueden robar). Penaliza leve.
    const cont = rules.runTop(cap, card.seq) + 1
    const leavesCarry = cont <= 10 && leftover.some(c => c.seq === cont)
    let score = pts * 1000 + cards * 10 + (caida ? 8 : 0) + (limpia ? 4 : 0)
    if (leavesCarry) score -= 6
    return { capture: true, captured: cap.map(c => c.id), pts, cards, score }
  }
  // Botar: evitar abrir ventana de robo y minimizar la caída que regalo al rival.
  const opensClaim = rules.captureExists(table, card) // si fuese true, mejor capturar; aquí cap=null igual
  const myHand = view.myHand || []
  const visibleSameRank = myHand.filter(c => c.r === card.r).length + table.filter(c => c.r === card.r).length
  const unseen = Math.max(0, 4 - visibleSameRank) // copias que podría tener el rival → caída
  let risk = unseen * 10 + (card.sum != null ? 4 : 0)
  if (opensClaim) risk += 100 // botar una carta "levantable" abre robo al rival
  return { capture: false, captured: [], pts: 0, cards: 0, score: -1000 - risk }
}

/** Decide la jugada del turno: { card, captured }. Niveles: 1 azar / 2 normal / 3 duro. */
export function choosePlay (rules, view, opts = {}) {
  const level = opts.level || 2
  const hand = view.myHand || []
  if (!hand.length) return null
  const scored = hand.map(c => ({ c, ...evaluatePlay(rules, view, c) }))

  if (level <= 1) {
    const caps = scored.filter(s => s.capture)
    const pick = caps.length ? caps[Math.floor(Math.random() * caps.length)] : scored[Math.floor(Math.random() * scored.length)]
    return { card: pick.c.id, captured: pick.captured }
  }
  let best = -Infinity
  for (const s of scored) if (s.score > best) best = s.score
  const margin = level >= 3 ? 0 : 5
  const top = scored.filter(s => best - s.score <= margin)
  const pick = top[Math.floor(Math.random() * top.length)]
  return { card: pick.c.id, captured: pick.captured }
}

/** Ventana de claim: mejor robo de la carta dejada, o null si no puedo levantarla. */
export function chooseRob (rules, view) {
  const table = view.table || []
  const result = table.find(c => c.id === view.claimCardId)
  if (!result) return null
  const cap = bestCapture(table, result, view.claimCardId)
  if (!cap || !cap.length || !rules.isValidCapture(result, cap)) return null // nunca robo inválido
  return { captured: cap.map(c => c.id) }
}

/**
 * Corte inicial por la data (fase 'draw'): cada jugador escoge UNA carta boca abajo
 * del mazo; la más alta gana la data (reparte). Las cartas están ocultas, así que la
 * elección es puramente al azar entre los índices libres. Devuelve { index } o null
 * si ya escogí o no quedan índices.
 */
export function chooseCut (rules, view) {
  const d = view.draw
  if (!d || d.myPick) return null // ya escogí (o no estamos en corte)
  const taken = new Set(d.takenIndexes || [])
  const free = []
  for (let i = 0; i < d.total; i++) if (!taken.has(i)) free.push(i)
  if (!free.length) return null
  return { index: free[Math.floor(Math.random() * free.length)] }
}

/** Carry (robo de continuación): mejor escalera desde `carry.value` con cartas de la
 *  mesa, o null. No usa carta de la mano ni resultado: es robo puro de la mesa. */
export function chooseCarryRob (rules, view) {
  const base = view.carry?.value
  if (base == null) return null
  const table = view.table || []
  const run = bestCapture(table, { seq: base }, null) // escalera contigua desde `base`
  if (!run || !run.length) return null
  if (!rules.isRunFrom(run, base)) return null // sanidad: debe arrancar en base
  return { captured: run.map(c => c.id) }
}
