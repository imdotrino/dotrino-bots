// Two chat bots in a throwaway room against the real proxy: A says one line, B must read it.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fork } from 'node:child_process'
import { Identity } from '@dotrino/identity/node'
const role = process.env.ROLE
if (!role) {
  const base = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'bots-smoke-')); const room = 'smoke' + Date.now()
  const kids = ['a', 'b'].map(r => fork(new URL(import.meta.url).pathname, [], { env: { ...process.env, ROLE: r, DIR: path.join(base, r), ROOM: room } }))
  let ok = false
  kids[1].on('message', (m) => { if (m === 'got') { ok = true; console.log('SMOKE OK: B read the sealed line'); kids.forEach(k => k.kill()); process.exit(0) } })
  setTimeout(() => { console.log('SMOKE FAIL: timeout'); kids.forEach(k => k.kill()); process.exit(1) }, 60000)
} else {
  const identity = await Identity.connect({ dir: process.env.DIR })
  const { createTransport } = await import('../src/core/transport.js')
  const { ChatBot } = await import('../src/bots/chat-bot.js')
  const transport = await createTransport({ identity, dir: process.env.DIR })
  const bot = new ChatBot({ identity, transport, brain: { composeChat: async () => null }, nickname: 'smoke-' + role, room: process.env.ROOM, log: console.log })
  bot._scheduleNext = () => {}
  const abs = bot._absorb.bind(bot)
  bot._absorb = (t, n) => { if (t === 'hola sellado') process.send('got'); return abs(t, n) }
  await bot.start()
  if (role === 'a') {
    const t = setInterval(async () => { if (await bot.sendChat('hola sellado')) { console.log('A sent'); clearInterval(t) } }, 1500)
  }
}
