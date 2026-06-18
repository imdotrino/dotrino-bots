/**
 * Ecosistema PM2 de la colección de bots de Dotrino.
 *
 * Cada bot es una app PM2 independiente (restart, logs y monitoreo propios),
 * lanzando `src/bot-process.js` con su identidad/sala vía variables de entorno.
 * La flota se define en `bots.config.json` (generado con `src/gen-ecosystem.js`);
 * si no existe, cae a una flota por defecto de 2 bots en #general.
 *
 *   node src/gen-ecosystem.js --app chat --room general --count 3
 *   npx pm2 start ecosystem.config.cjs
 *   npx pm2 logs ccbots        # namespace
 *   npx pm2 stop ccbots && npx pm2 delete ccbots
 *
 * No hace falta cargar el .env aquí: cada bot lee DEEPSEEK_API_KEY del .env de la
 * raíz del ecosistema (vía src/core/env.js).
 */
const fs = require('fs')
const path = require('path')

const ROOT = __dirname
const CONFIG = path.join(ROOT, 'bots.config.json')

const DEFAULT_FLEET = [
  { name: 'Lucia', persona: 'Lucía, 28 años, diseñadora gráfica curiosa y de buen humor, le gusta el cine y los memes', app: 'chat', room: 'general' },
  { name: 'Mateo', persona: 'Mateo, 34 años, programador relajado, fan del mate y del fútbol, irónico pero amable', app: 'chat', room: 'general' }
]

function loadFleet () {
  try {
    if (fs.existsSync(CONFIG)) {
      const f = JSON.parse(fs.readFileSync(CONFIG, 'utf8'))
      if (Array.isArray(f) && f.length) return f
    }
  } catch (_) { /* usa default */ }
  return DEFAULT_FLEET
}

const fleet = loadFleet()

module.exports = {
  apps: fleet.map((b) => {
    const slug = b.name.toLowerCase()
    return {
      name: `ccbot-${b.app}-${slug}`,
      namespace: 'ccbots',
      script: path.join(ROOT, 'src', 'bot-process.js'),
      cwd: ROOT,
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 5000,            // evita reconexión en bucle apretado
      max_memory_restart: '200M',
      kill_timeout: 6000,             // deja terminar el unpublish + close limpio
      time: true,                     // timestamps en los logs de PM2
      merge_logs: true,
      out_file: path.join(ROOT, 'logs', `${b.app}-${slug}.out.log`),
      error_file: path.join(ROOT, 'logs', `${b.app}-${slug}.err.log`),
      env: {
        BOT_DIR: path.join(ROOT, 'identities', b.app, slug),
        BOT_NAME: b.name,
        BOT_PERSONA: b.persona,
        BOT_APP: b.app,
        BOT_ROOM: b.room,
        ...(b.app === 'chess' && b.engine ? { BOT_CHESS_ENGINE: b.engine } : {}),
        ...(b.app === 'cuarenta'
          ? { BOT_ROLE: b.role || 'host', BOT_TABLE_SIZE: String(b.size || 2), BOT_CUARENTA_ENGINE: b.engine || 'heuristic:2' }
          : {})
      }
    }
  })
}
