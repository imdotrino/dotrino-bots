/**
 * Instala los globals del navegador que esperan los paquetes del ecosistema
 * cuando corren en Node: `WebSocket` (paquete `ws`) y un `localStorage`
 * respaldado en archivo (para el keypair de transporte del proxy-client).
 *
 * Lo usan tanto el transporte del chat como el lobby del ajedrez.
 */
import fs from 'node:fs'
import path from 'node:path'
import WebSocket from 'ws'

/** localStorage síncrono respaldado por archivo (solo lo que usan los paquetes). */
export function fileLocalStorage (filePath) {
  let data = {}
  try { if (fs.existsSync(filePath)) data = JSON.parse(fs.readFileSync(filePath, 'utf8')) || {} } catch (_) {}
  const flush = () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, JSON.stringify(data))
  }
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); flush() },
    removeItem: (k) => { delete data[k]; flush() },
    clear: () => { data = {}; flush() },
    key: (i) => Object.keys(data)[i] ?? null,
    get length () { return Object.keys(data).length }
  }
}

let _installed = false
export function installNodeGlobals (dir) {
  if (_installed) return
  if (typeof globalThis.WebSocket === 'undefined') globalThis.WebSocket = WebSocket
  // Node ≥22 expone un `localStorage` no funcional sin flag → forzamos el shim.
  globalThis.localStorage = fileLocalStorage(path.join(dir, 'transport.json'))
  _installed = true
}
