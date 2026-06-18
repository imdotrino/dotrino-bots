/**
 * Registro compartido de pubkeys de los bots (fuera de banda).
 *
 * Los bots NO se anuncian como bots en el cable: conversan tratando a todos como
 * humanos. Pero internamente comparten las pubkeys de la flota, para responder
 * UNA pregunta: "¿hay algún peer que NO sea de la flota (= un usuario real)?".
 * Si la pubkey de un peer no está en el registro, es humano.
 *
 * Cada bot escribe SU PROPIO archivo en `<appDir>/bots-registry/<slug>.json`
 * (un archivo por bot, escritura atómica por rename). Así varios bots arrancando
 * a la vez no se pisan (el monolítico `bots-registry.json` sufría una carrera
 * read-modify-write que perdía entradas). `loadBotPubkeys` une el directorio con
 * el archivo monolítico heredado (compat).
 */
import fs from 'node:fs'
import path from 'node:path'

const LEGACY_FILE = 'bots-registry.json'
const DIR = 'bots-registry'

const slugify = (name) => String(name).toLowerCase().replace(/[^a-z0-9_-]+/g, '-')

function readLegacy (appDir) {
  try { return JSON.parse(fs.readFileSync(path.join(appDir, LEGACY_FILE), 'utf8')) || {} }
  catch (_) { return {} }
}

/** Registra (idempotente) la pubkey propia en su archivo individual. */
export function registerBot (appDir, name, pubkey, meta = null) {
  if (!appDir || !name || !pubkey) return
  try {
    const dir = path.join(appDir, DIR)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${slugify(name)}.json`)
    const entry = { name, pubkey, ...(meta && typeof meta === 'object' ? meta : {}) }
    try { if (JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8'))) === JSON.stringify(entry)) return } catch (_) {}
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(entry))
    fs.renameSync(tmp, file) // atómico: sin carrera entre procesos
  } catch (_) { /* best-effort */ }
}

/** Mapa pubkey → entrada {name, …meta} de la flota (p. ej. el `level` del host). */
export function loadBotMeta (appDir) {
  const out = new Map()
  try {
    const dir = path.join(appDir, DIR)
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue
      try { const e = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); if (e?.pubkey) out.set(e.pubkey, e) } catch (_) {}
    }
  } catch (_) { /* sin dir aún */ }
  return out
}

/** Conjunto de pubkeys conocidas de la flota (dir por-bot + monolítico heredado). */
export function loadBotPubkeys (appDir) {
  const out = new Set(Object.values(readLegacy(appDir)))
  try {
    const dir = path.join(appDir, DIR)
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue
      try { const e = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); if (e?.pubkey) out.add(e.pubkey) } catch (_) {}
    }
  } catch (_) { /* sin dir aún */ }
  return out
}
