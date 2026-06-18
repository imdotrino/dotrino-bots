/**
 * Bot de chat headless para `simple-websocket-chat`.
 *
 * Habla EXACTAMENTE el protocolo del roomStore de la app (mensajes `TIPO|JSON`
 * sobre el canal `chat_room_<sala>`): publica su presencia, hace el handshake
 * de identidad (IDENTIFY_CHALLENGE/RESPONSE), intercambia encryptionPubkey y
 * envía/recibe mensajes cifrados E2E (CHAT_ENC).
 *
 * Comportamiento conversacional (lo decide el bot; DeepSeek sólo redacta):
 *   - INTERÉS (0..1): indicador que el bot maneja. Gobierna la latencia hasta
 *     responder, de ~30s (enganchado) a ~30min (desganado). Sube con novedad y
 *     cuando le hablan; baja con el tiempo y la repetición.
 *   - DERIVA DE TEMA: si la charla se vuelve repetitiva, toma una PALABRA del
 *     último mensaje y pivota a un tema nuevo (eso re-energiza su interés).
 *   - PREGUNTAS + STANDBY + ENOJO: a veces pregunta (a veces dirigido a alguien);
 *     al preguntar entra en espera (no insiste); si nadie responde, da un empujón
 *     y luego se fastidia y se desengancha. Si le responden, vuelve a engancharse.
 *
 * No carga la app web: no dispara GoatCounter ni ninguna analítica del front.
 */
import { sleep, typeMs, replyDelayMs, randInt } from '../core/human.js'
import { registerBot, loadBotPubkeys } from '../core/registry.js'

const fmt = (type, payload) => `${type}|${JSON.stringify(payload)}`
function parse (raw) {
  const s = typeof raw === 'string' ? raw : JSON.stringify(raw)
  const i = s.indexOf('|')
  if (i < 0) return { type: null, payload: null }
  try { return { type: s.slice(0, i), payload: JSON.parse(s.slice(i + 1)) } }
  catch { return { type: null, payload: null } }
}

const MAX_HISTORY = 50 // memoria acotada: el bot recuerda a lo sumo 50 mensajes
const clamp = (v, lo = 0.05, hi = 1) => Math.max(lo, Math.min(hi, v))
const STOP = new Set(['para', 'pero', 'como', 'esto', 'esta', 'este', 'eso', 'esa', 'que', 'qué', 'con', 'por', 'una', 'unos', 'unas', 'los', 'las', 'del', 'más', 'mas', 'muy', 'sin', 'sus', 'son', 'fue', 'hay', 'ese', 'aqui', 'aquí', 'todo', 'toda', 'nada', 'algo', 'cosa', 'cosas', 'tipo', 'igual', 'gente', 'jaja', 'jajaja'])

export class ChatBot {
  constructor ({ identity, transport, brain, nickname, room, topics = null, registryDir = null, log = console.log }) {
    this.id = identity
    this.tp = transport
    this.client = transport.client
    this.brain = brain
    this.topics = topics
    this.registryDir = registryDir
    this.botPubkeys = new Set() // pubkeys de la flota (registro fuera de banda)
    this.nickname = nickname
    this.room = room
    this.log = (...a) => log(`[${nickname}]`, ...a)
    this.members = new Map() // token -> { token, nickname, pubkey, encryptionPubkey, lastSeen }
    this.history = []        // { name, text, isMe, ts }
    this.lastSpokeAt = 0
    this.interest = 0.6      // 0..1 — el indicador que maneja el bot
    this.topicTurns = 0      // mensajes desde el último cambio de tema (madurez del tópico)
    this.awaiting = null     // { since, deadline, attempts } cuando hizo una pregunta
    this._mention = null     // { name, text } cuando alguien lo nombró y debe responderle
    this._tickTimer = null
    this._fireAt = 0
    this._timers = []
    this._stopped = false
  }

  get channel () { return `chat_room_${this.room}` }
  get myToken () { return this.client.token }

  async start () {
    await this.id.setMyNickname(this.nickname)
    this._registerSelf()    // publica mi pubkey en el registro de la flota
    this._reloadRegistry()   // y cargo las de mis compañeros
    if (this.topics) this.topics.warm().catch(() => {}) // consulta el feed al iniciar
    this._wireEvents()
    await this.join()
    // Heartbeat: descubrimiento + HEARTBEAT (para detectar humanos) cada 20s.
    // El RE-PUBLISH del canal va aparte y espaciado: el TTL del proxy es 20 min,
    // así que republicar cada pocos segundos solo genera churn ('joined' a los
    // watchers). Se re-publica cada 10 min (holgado bajo el TTL).
    const beat = setInterval(() => this._heartbeat().catch(() => {}), 20000)
    this._timers.push(beat)
    const rep = setInterval(() => { this.client.publish(this.channel, { nickname: this.nickname, roomName: this.room }).catch(() => {}) }, 10 * 60 * 1000)
    this._timers.push(rep)
    // Primer "tick" con arranque ESCALONADO y amplio (3s–80s) para que los bots
    // no abran todos a la vez. El primero abre; cuando los otros despiertan ya
    // hay historia y responden en vez de soltar otra apertura simultánea.
    this._scheduleNext(randInt(3000, 80000))
  }

  _wireEvents () {
    this.client.on('message', (from, payload) => {
      const raw = typeof payload === 'string' ? payload : JSON.stringify(payload)
      this._onMessage(from, raw).catch(e => this.log('onMessage err', e.message))
    })
    this.client.on('channel_joined', (channel, token) => {
      if (channel === this.channel && token !== this.myToken) this._discover(token)
    })
    this.client.on('peer_disconnected', (token) => { this.members.delete(token) })
    this.client.on('channel_left', (channel, token) => { if (channel === this.channel) this.members.delete(token) })

    // Reconexión: el proxy asigna un token nuevo → hay que re-publicar y
    // reanunciarse, si no el bot queda fuera del canal aunque el proceso viva.
    let bootToken = true
    this.client.on('token', () => {
      if (bootToken) { bootToken = false; return }
      this.log('reconexión (token nuevo) → re-publico y reanuncio')
      this.join().catch(e => this.log('re-join err', e.message))
    })
    this.client.on('disconnect', () => this.log('socket caído'))
    this.client.on('reconnect_failed', () => {
      this.log('reconexión agotada → reintento connect')
      this.client.connect().catch(() => {})
    })
  }

  async join () {
    await this.client.publish(this.channel, { nickname: this.nickname, roomName: this.room })
    this.log(`unido a #${this.room} (token ${this.myToken?.slice(0, 8)}…)`)
    let tokens = []
    try { tokens = await this.client.list(this.channel) } catch (_) {}
    const others = tokens.filter(t => t !== this.myToken)
    for (const t of others) this._discover(t)
    if (others.length) {
      const announce = fmt('JOIN_ANNOUNCE', { nickname: this.nickname, roomName: this.room, timestamp: Date.now() })
      try { this.client.send(others, announce) } catch (_) {}
    }
  }

  _discover (token) {
    if (token === this.myToken) return
    if (!this.members.has(token)) this.members.set(token, { token, nickname: token, lastSeen: Date.now() })
    this._challenge(token).catch(() => {})
  }

  async _challenge (token) {
    const { nonce } = await this.id.makeChallenge()
    this.client.send([token], fmt('IDENTIFY_CHALLENGE', { nonce }))
  }

  async _onMessage (from, raw) {
    const { type, payload } = parse(raw)
    if (!type) return
    const m = this.members.get(from)
    if (m) m.lastSeen = Date.now()
    switch (type) {
      case 'IDENTIFY_CHALLENGE': {
        if (!payload?.nonce) return
        const resp = await this.id.signChallenge(payload.nonce)
        this.client.send([from], fmt('IDENTIFY_RESPONSE', resp))
        break
      }
      case 'IDENTIFY_RESPONSE': {
        const res = await this.id.verifyResponse(payload || {})
        if (!res?.ok) return
        const mem = this.members.get(from) || { token: from, lastSeen: Date.now() }
        mem.pubkey = res.publickey
        mem.encryptionPubkey = res.encryptionPubkey || payload.encryptionPubkey || null
        this.members.set(from, mem)
        this._classify(mem) // ya conocemos su pubkey → bot (de la flota) o humano
        break
      }
      case 'JOIN_ANNOUNCE':
      case 'HEARTBEAT': {
        const mem = this.members.get(from) || { token: from }
        if (payload?.nickname) mem.nickname = payload.nickname
        mem.lastSeen = Date.now()
        this.members.set(from, mem)
        if (!mem.encryptionPubkey) this._challenge(from).catch(() => {})
        break
      }
      case 'CHAT_ENC':
        await this._onEncryptedChat(from, payload)
        break
      case 'RATING_QUERY': {
        if (!payload?.subject || !payload?.queryId) return
        const { mine, endorsements } = await this.id.getRatingsForSubject(payload.subject)
        this.client.send([from], fmt('RATING_REPLY', { queryId: payload.queryId, subject: payload.subject, mine, endorsements }))
        break
      }
      default:
        break
    }
  }

  async _onEncryptedChat (from, payload) {
    if (!payload?.envelope) return
    if (payload.roomName && payload.roomName !== this.room) return
    const mem = this.members.get(from)
    if (!mem?.encryptionPubkey) { this._challenge(from).catch(() => {}); return }
    let plaintext
    try {
      const r = await this.id.decrypt(mem.encryptionPubkey, this.myToken, payload.envelope)
      plaintext = r.plaintext
    } catch (_) { return }
    const name = payload.nickname || mem.nickname || from.slice(0, 8)
    this.history.push({ name, text: plaintext, isMe: false, ts: payload.timestamp || Date.now() })
    if (this.history.length > MAX_HISTORY) this.history.shift()
    this.log(`← ${name}: ${plaintext}`)
    this.topicTurns++
    this._absorb(plaintext, name)
  }

  /** Ajusta el interés ante un mensaje entrante y reacciona al standby. */
  _absorb (text, fromName = null) {
    const nov = this._novelty(text)
    this.interest = clamp(this.interest + (nov - 0.4) * 0.5)
    const mentioned = this._addressesMe(text)
    if (this.awaiting) {
      // Alguien habló después de mi pregunta → lo tomo como respuesta.
      this.awaiting = null
      this.interest = clamp(this.interest + 0.2)
      this.log(`me respondieron → re-enganchado (interés ${this.interest.toFixed(2)})`)
    }
    if (mentioned) {
      // Me nombraron directamente → interés alto, le respondo a esa persona pronto.
      this._mention = { name: fromName, text }
      this.interest = clamp(Math.max(this.interest + 0.4, 0.92))
      this._arm(randInt(6000, 22000))
      this.log(`me nombró ${fromName || 'alguien'} → interés ${this.interest.toFixed(2)}, le respondo`)
      return
    }
    this._pullCloser() // un mensaje interesante me acerca la próxima intervención
  }

  // ----- envío -----

  _recipients () {
    return [...this.members.values()].filter(m => m.encryptionPubkey).map(m => ({ token: m.token, encryptionPubkey: m.encryptionPubkey }))
  }

  async sendChat (text) {
    const recipients = this._recipients()
    if (recipients.length === 0) return false
    const envelope = await this.id.encrypt(recipients, text)
    const msg = fmt('CHAT_ENC', { envelope, nickname: this.nickname, roomName: this.room, timestamp: Date.now() })
    this.client.send(recipients.map(r => r.token), msg)
    this.history.push({ name: this.nickname, text, isMe: true, ts: Date.now() })
    if (this.history.length > MAX_HISTORY) this.history.shift()
    this.lastSpokeAt = Date.now()
    this.topicTurns++
    return true
  }

  /** Compone (DeepSeek) y envía con tiempo de tipeo. `track` arma el standby. */
  async _speak (mode, opts = {}, track = true) {
    await sleep(randInt(800, 2600)) // micro-pausa de "empezar a escribir"
    if (this._stopped) return
    let text = await this.brain.composeChat(this.history, this.room, { mode, ...opts })
    if (!text) return
    // Anti-eco: si mi propio candidato repite lo reciente, lo regenero como
    // cambio de tema (con pregunta) — fuerza aportar algo nuevo.
    if (/^(normal|opener|shift)$/.test(mode) && this._novelty(text, this.history.slice(-8)) < 0.25) {
      const retry = await this.brain.composeChat(this.history, this.room, { mode: 'shift', trigger: this._trigger(), wantQuestion: true })
      if (retry && this._novelty(retry, this.history.slice(-8)) > this._novelty(text, this.history.slice(-8))) {
        text = retry
        if (mode !== 'shift') { mode = 'shift'; this.topicTurns = 0 }
      }
    }
    await sleep(typeMs(text))
    if (this._stopped) return
    const ok = await this.sendChat(text)
    if (!ok) return
    this.log(`→ [${mode} i=${this.interest.toFixed(2)}] ${text}`)
    if (track && /\?/.test(text)) {
      this.awaiting = { since: Date.now(), deadline: Date.now() + randInt(60000, 240000), attempts: 0 }
      this.log('pregunta hecha → standby esperando respuesta')
    }
  }

  // ----- scheduler gobernado por el interés -----

  _arm (ms) {
    if (this._tickTimer) clearTimeout(this._tickTimer)
    this._fireAt = Date.now() + ms
    this._tickTimer = setTimeout(() => this._onTick().catch(() => {}), ms)
  }

  _scheduleNext (forceMs = null) {
    let ms = forceMs != null ? forceMs : replyDelayMs(this.interest)
    if (this.awaiting) {
      const tl = this.awaiting.deadline - Date.now()
      ms = Math.min(ms, Math.max(5000, tl)) // despertar cerca del deadline del standby
    }
    this._arm(ms)
    const s = Math.round(ms / 1000)
    this.log(`⏳ próx ~${s >= 90 ? Math.round(s / 60) + 'min' : s + 's'} (interés ${this.interest.toFixed(2)}${this.awaiting ? ', en espera' : ''})`)
  }

  /** Un mensaje entrante interesante puede adelantar la próxima intervención. */
  _pullCloser () {
    const want = Date.now() + replyDelayMs(this.interest)
    if (want < this._fireAt) this._arm(want - Date.now())
  }

  async _onTick () {
    if (this._stopped) return
    this._reloadRegistry() // clasificación al día antes de decidir si hablar
    try {
      if (!this._humanPresent()) {
        // Sin usuario real en la sala: los bots NO charlan entre ellos. Sólo
        // mantienen presencia (heartbeat/re-publish corren aparte).
        this.awaiting = null
        this.interest = clamp(this.interest - 0.05)
      } else if (this.awaiting) {
        if (Date.now() >= this.awaiting.deadline) await this._escalate()
        // si no venció: standby, no hablo
      } else if (this._recipients().length && this._shouldSpeak()) {
        await this._decideAndSpeak()
      } else {
        this.interest = clamp(this.interest - 0.05) // se enfría si no pasa nada
      }
    } catch (e) { this.log('tick err', e.message) }
    this._scheduleNext()
  }

  _shouldSpeak () {
    if (this._mention) return true // me nombraron → respondo seguro
    const last = this.history[this.history.length - 1]
    if (!last) return true // sala recién armada: alguien tiene que arrancar
    if (last && !last.isMe && this._addressesMe(last.text)) return true // me nombraron → respondo seguro
    if (!last.isMe && last.ts > this.lastSpokeAt) return Math.random() < (0.4 + 0.55 * this.interest)
    const idle = Date.now() - last.ts
    if (idle > 180000) return Math.random() < (0.15 + 0.3 * this.interest) // revivir tras 3min de silencio
    return false
  }

  async _decideAndSpeak () {
    const last = this.history[this.history.length - 1]
    const idle = Date.now() - (last?.ts || 0)
    const reviving = idle > 150000 // estuvo callado un rato → reintroduce tópico
    // Preguntas POCO recurrentes: la mayoría de los mensajes son afirmaciones.
    let wantQuestion = Math.random() < (0.12 + 0.22 * this.interest)
    let mode = 'normal'; let trigger = null; let targetName = null; let headline = null; let mentionText = null
    if (this._mention) {
      // Alguien me nombró → le respondo directamente, contestando lo que dijo.
      mode = 'reply'; targetName = this._mention.name; mentionText = this._mention.text
      wantQuestion = Math.random() < 0.2
      this._mention = null
      await this._speak(mode, { targetName, mentionText, wantQuestion })
      this.interest = clamp(this.interest - 0.04)
      return
    }
    if (this.history.length === 0) {
      // Apertura sembrada por el feed (evita temas recurrentes inventados).
      headline = await this._topicHeadline()
      if (headline) { mode = 'shift'; wantQuestion = Math.random() < 0.5 }
      else { mode = 'opener'; wantQuestion = Math.random() < 0.6 }
    } else if (reviving) {
      // Charla muerta → reintroduce con noticia actual.
      mode = 'shift'; wantQuestion = Math.random() < 0.5
      headline = await this._topicHeadline(); if (!headline) trigger = this._trigger()
    } else if (this._repetitive() || this.interest < 0.3) {
      // Charla trabada/repetitiva → noticia actual como tema fresco.
      mode = 'shift'
      headline = await this._topicHeadline(); if (!headline) trigger = this._trigger()
    } else if (Math.random() < 0.12) {
      // Pivote de tema, preferentemente con una noticia del feed (variedad).
      mode = 'shift'
      headline = await this._topicHeadline(); if (!headline) trigger = this._trigger()
    } else {
      targetName = this._maybeTarget()
    }
    await this._speak(mode, { trigger, targetName, wantQuestion, headline })
    if (mode === 'shift' || mode === 'opener') {
      this.topicTurns = 0
      this.interest = clamp(Math.max(this.interest, 0.7)) // tópico nuevo re-energiza
    } else {
      // El tópico converge: cuanto más maduro, más rápido se enfría el interés.
      this.interest = clamp(this.interest - (0.04 + Math.min(0.08, this.topicTurns * 0.012)))
    }
  }

  /** Venció el standby: primero un empujón, luego fastidio y desenganche. */
  async _escalate () {
    this.awaiting.attempts++
    if (this.awaiting.attempts === 1) {
      await this._speak('nudge', {}, false)
      this.awaiting.deadline = Date.now() + randInt(45000, 120000)
      this.interest = clamp(this.interest - 0.12)
      this.log(`sin respuesta → empujón (interés ${this.interest.toFixed(2)})`)
    } else {
      await this._speak('annoyed', {}, false)
      this.awaiting = null
      this.interest = 0.12 // se desengancha → próximas intervenciones muy espaciadas
      this.log('sin respuesta → fastidiado, me desengancho')
    }
  }

  // ----- novedad / repetición / disparadores -----

  _tokens (text) {
    return (String(text || '').toLowerCase().match(/[a-záéíóúñü]{4,}/gi) || []).filter(w => !STOP.has(w))
  }

  /** 1 = totalmente nuevo, 0 = repite lo reciente (Jaccard contra `recent`). */
  _novelty (text, recent = this.history.slice(0, -1).slice(-8)) {
    const cur = new Set(this._tokens(text))
    if (cur.size === 0) return 0.5
    let maxSim = 0
    for (const h of recent) {
      const prev = new Set(this._tokens(h.text))
      if (prev.size === 0) continue
      const inter = [...cur].filter(w => prev.has(w)).length
      const uni = new Set([...cur, ...prev]).size
      const sim = uni ? inter / uni : 0
      if (sim > maxSim) maxSim = sim
    }
    return 1 - maxSim
  }

  /** La conversación se está repitiendo (mucho token repetido en lo último). */
  _repetitive () {
    const texts = this.history.slice(-5).map(h => h.text)
    if (texts.length < 4) return false
    const seen = new Set(); let repeats = 0; let total = 0
    for (const t of texts) for (const w of this._tokens(t)) { total++; if (seen.has(w)) repeats++; else seen.add(w) }
    return total > 0 && repeats / total > 0.45
  }

  /** Palabra notable del último mensaje ajeno, para pivotar de tema. */
  _trigger () {
    const lastOther = [...this.history].reverse().find(h => !h.isMe)
    if (!lastOther) return null
    const toks = this._tokens(lastOther.text).sort((a, b) => b.length - a.length)
    return toks[0] || null
  }

  /**
   * Clasifica un peer una vez conocida su pubkey (tras el handshake): si su
   * pubkey está en el registro de la flota es 'bot'; si no, es un usuario real.
   * No hay nada en el cable que lo delate: la conversación trata a todos igual.
   */
  _classify (mem) {
    if (!mem || !mem.pubkey) return
    let isBot = this.botPubkeys.has(mem.pubkey)
    if (!isBot) {
      // Posible carrera de arranque: un compañero todavía no registró su pubkey.
      // Releo el registro fresco antes de declararlo "humano".
      this.botPubkeys = loadBotPubkeys(this.registryDir)
      isBot = this.botPubkeys.has(mem.pubkey)
    }
    const kind = isBot ? 'bot' : 'human'
    const was = mem.kind
    mem.kind = kind
    if (kind === 'human' && was !== 'human') this._onHumanDetected()
  }

  /** Relee el registro de la flota y reclasifica a los miembros conocidos. */
  _reloadRegistry () {
    this.botPubkeys = loadBotPubkeys(this.registryDir)
    for (const m of this.members.values()) if (m.pubkey) this._classify(m)
  }

  _registerSelf () {
    try { registerBot(this.registryDir, this.nickname, this.id.me?.publickey) } catch (_) {}
  }

  _onHumanDetected () {
    this.interest = clamp(Math.max(this.interest, 0.6))
    this._arm(randInt(4000, 20000)) // me activo pronto para atender al usuario real
    this.log('usuario real detectado → me activo')
  }

  /** ¿Hay al menos un usuario real activo (visto en los últimos 2 min)? */
  _humanPresent () {
    const now = Date.now()
    for (const m of this.members.values()) {
      if (m.kind === 'human' && now - (m.lastSeen || 0) < 120000) return true
    }
    return false
  }

  /** Un titular actual del feed para sembrar un tema nuevo (o null). */
  async _topicHeadline () {
    if (!this.topics) return null
    try { return await this.topics.randomHeadline() } catch { return null }
  }

  _addressesMe (text) {
    return new RegExp(`\\b${this.nickname}\\b`, 'i').test(String(text || ''))
  }

  _maybeTarget () {
    if (Math.random() > 0.18) return null // nombrar a alguien es ocasional, no la norma
    const names = [...this.members.values()].map(m => m.nickname).filter(n => n && n !== this.nickname && n.length < 20)
    return names.length ? names[Math.floor(Math.random() * names.length)] : null
  }

  async _heartbeat () {
    if (this._stopped) return
    // Recargar la flota (auto-cura carreras de arranque). El re-publish va en su
    // propio timer espaciado (10 min) para no reordenar/notificar el canal.
    this._registerSelf()
    this._reloadRegistry()
    let tokens = []
    try { tokens = await this.client.list(this.channel) } catch (_) {}
    const others = tokens.filter(t => t !== this.myToken)
    for (const t of others) if (!this.members.has(t)) this._discover(t)
    if (others.length) {
      const hb = fmt('HEARTBEAT', { nickname: this.nickname, roomName: this.room, timestamp: Date.now() })
      try { this.client.send(others, hb) } catch (_) {}
    }
  }

  async stop () {
    this._stopped = true
    if (this._tickTimer) clearTimeout(this._tickTimer)
    for (const t of this._timers) { clearTimeout(t); clearInterval(t) }
    try { await this.client.unpublish(this.channel) } catch (_) {}
    try { this.client.close() } catch (_) {}
  }
}
