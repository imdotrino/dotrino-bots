/**
 * Carga de variables de entorno desde el `.env` de la raíz del ecosistema
 * (un nivel arriba del repo de bots) y desde process.env. Sin dependencias.
 *
 * La única secreta que necesitan los bots es DEEPSEEK_API_KEY (el "cerebro").
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..') // dotrino-bots/
const ECO_ROOT = path.resolve(ROOT, '..')        // Dotrino/

function parseEnvFile (file) {
  const out = {}
  try {
    const txt = fs.readFileSync(file, 'utf8')
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i)
      if (!m) continue
      let v = m[2]
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      out[m[1]] = v
    }
  } catch (_) { /* sin .env */ }
  return out
}

// Precedencia: process.env > .env del repo > .env del ecosistema.
const fromEco = parseEnvFile(path.join(ECO_ROOT, '.env'))
const fromRepo = parseEnvFile(path.join(ROOT, '.env'))
const merged = { ...fromEco, ...fromRepo, ...process.env }

export const env = merged
export const DEEPSEEK_API_KEY = merged.DEEPSEEK_API_KEY || ''
export const PROXY_URL = merged.PROXY_URL || 'wss://proxy.dotrino.com'
export const REPO_ROOT = ROOT
