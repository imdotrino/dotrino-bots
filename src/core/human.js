/**
 * Latencias humanas. Los bots no responden ni actúan al instante: "piensan",
 * "tipean" y dejan huecos variables entre acciones, con jitter, para que la
 * actividad simulada se parezca a la de una persona real.
 */

export const sleep = (ms) => new Promise(r => setTimeout(r, Math.max(0, ms)))

/** Entero aleatorio en [min, max]. */
export const randInt = (min, max) => Math.floor(min + Math.random() * (max - min + 1))

/** Valor aleatorio en [base*(1-spread), base*(1+spread)]. */
export const jitter = (base, spread = 0.35) => base * (1 + (Math.random() * 2 - 1) * spread)

/**
 * Pausa de "pensar" antes de empezar a tipear: corta (1.2-5s). El grueso de la
 * latencia entre mensajes lo gobierna `replyDelayMs(interest)`, no esto.
 */
export function thinkMs () {
  const base = randInt(1200, 5000)
  const distracted = Math.random() < 0.15 ? randInt(4000, 15000) : 0
  return base + distracted
}

export const MIN_REPLY_MS = 30 * 1000            // 30 s (muy interesado)
export const MAX_REPLY_MS = 30 * 60 * 1000       // 30 min (desganado)

/**
 * Tiempo hasta la próxima consideración de hablar, en función del INTERÉS del
 * bot en la conversación (0 = nada, 1 = enganchadísimo). Interés alto → cerca
 * de 30s; interés bajo → hasta 30min. Con jitter para que no sea mecánico.
 *
 * @param {number} interest  en [0,1]
 */
export function replyDelayMs (interest) {
  const i = Math.max(0, Math.min(1, interest))
  const base = MAX_REPLY_MS - (MAX_REPLY_MS - MIN_REPLY_MS) * i
  const j = jitter(base, 0.35)
  return Math.round(Math.max(MIN_REPLY_MS, Math.min(MAX_REPLY_MS, j)))
}

/**
 * Tiempo de "tipeo" proporcional al largo del texto: ~45-95 ms por carácter,
 * con piso y techo razonables. Simula escribir el mensaje.
 */
export function typeMs (text) {
  const perChar = jitter(60, 0.4)
  return Math.min(22000, Math.max(700, Math.round((text?.length || 1) * perChar)))
}

/**
 * Hueco entre acciones autónomas (cada cuánto el bot "mira" el chat y quizá
 * decide hablar). Variable para que no haya cadencia mecánica.
 */
export function idleGapMs () {
  return randInt(8000, 35000)
}
