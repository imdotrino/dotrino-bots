/**
 * Bot de Cuarenta (40) headless para la app `cuarenta`, sobre
 * @dotrino/lobby (corre el motor OFICIAL de la app, reusado tal
 * cual). El cuarenta admite mesas de 2 y de 4 jugadores; un bot juega UN asiento
 * (1 identidad = 1 peer). Para "3 personas" en una mesa de 4 se levantan 3 bots
 * independientes (1 host + 2 fillers); cada uno es un usuario distinto.
 *
 * Roles:
 *  - host  : HOSTEA una mesa pública (de 2 ó 4), toma un asiento y deja libres los
 *            demás. NUNCA arranca sin un humano: sólo llama room.start() cuando la
 *            mesa está completa, todos listos y hay ≥1 jugador que NO es de la
 *            flota. Al terminar reabre una mesa nueva.
 *  - filler: (sólo mesas de 4) descubre mesas de 4 hosteadas por la flota y rellena
 *            asientos, dejando SIEMPRE ≥1 libre para un humano. Si por una carrera
 *            la mesa queda llena de puros bots, cede su asiento.
 *
 * Así una mesa de bots se distingue y NUNCA empieza a jugar entre bots sin un
 * humano sentado.
 *
 * Al arrancar hay un CORTE por la data (fase 'draw'): cada jugador escoge una carta
 * boca abajo y la más alta gana el reparto. El bot corta solo (índice al azar entre
 * los libres, porque las cartas están ocultas).
 *
 * Selección de carta 100% programática (heurística del motor); no usa DeepSeek.
 */
import { sleep, randInt } from '../core/human.js'
import { registerBot, loadBotPubkeys, loadBotMeta } from '../core/registry.js'

const MOVE_THINK_MIN = 1200    // pausa humana antes de jugar
const MOVE_THINK_MAX = 6000
const PAUSE_REOPEN_MS = 120000 // si alguien se va y no vuelve, el host reabre
const SCAN_INTERVAL_MS = 6000  // cada cuánto el filler busca mesas que rellenar

export class CuarentaBot {
  /**
   * @param {Object} o
   * @param {import('@dotrino/lobby').Lobby} o.lobby
   * @param {Object} o.identity
   * @param {Object} o.rules               exports de cuarentaRules.js
   * @param {Object} o.engine              estrategia de carta { name, bestMove }
   * @param {Function} o.setPendingConfig  del motor de la app (host fija activeSeats)
   * @param {Function} o.discoveryChannel  (gameId)=>canal de descubrimiento
   * @param {Function} o.roomChannel       (gameId, roomId)=>canal de la sala
   * @param {'host'|'filler'} o.role
   * @param {2|4} o.tableSize
   */
  constructor ({ lobby, identity, rules, engine, setPendingConfig, discoveryChannel, roomChannel, role = 'host', tableSize = 2, registryDir = null, nickname, log = console.log }) {
    this.lobby = lobby
    this.id = identity
    this.rules = rules
    this.engine = engine
    this.setPendingConfig = setPendingConfig
    this.discoveryChannel = discoveryChannel
    this.roomChannel = roomChannel
    this.role = role === 'filler' ? 'filler' : 'host'
    this.tableSize = tableSize === 4 ? 4 : 2
    this.level = engine?.level || 2 // dificultad (1 fácil · 2 normal · 3 difícil)
    this.registryDir = registryDir
    this.botPubkeys = new Set() // pubkeys de la flota → distinguir bots de humanos
    this.botMeta = new Map() // pubkey → {name, level} de la flota (emparejar por nivel)
    this.nickname = nickname
    this.log = (...a) => log(`[${nickname}]`, ...a)
    this.gameId = 'cuarenta'
    this.room = null
    this._stopped = false
    this._thinking = false
    this._pending = false // update llegado mientras pensaba → reprocesar al terminar
    this._claiming = false // filler: tomando asiento (evita doble takeSeat)
    this._reopenTimer = null
    this._pauseTimer = null
    this._presenceTimer = null
    this._scanTimer = null
  }

  async start () {
    await this.id.setMyNickname(this.nickname)
    this._registerSelf()  // publico mi pubkey en el registro de la flota
    this._reloadRegistry() // y cargo las de mis compañeros
    this.lobby.transport.on('reconnect', () => {
      this.log('reconexión')
      if (this.role === 'host') this._openRoom().catch(e => this.log('reopen err', e.message))
      else this._scan().catch(() => {})
    })
    if (this.role === 'host') {
      // TTL del canal ~20 min: republicar cada 10 basta para seguir visible.
      this._presenceTimer = setInterval(() => this._republish(), 10 * 60 * 1000)
      await this._openRoom()
    } else {
      this._scanTimer = setInterval(() => this._scan().catch(() => {}), SCAN_INTERVAL_MS)
      this.lobby.on('rooms-changed', () => this._scan().catch(() => {}))
      await this._scan()
    }
  }

  _registerSelf () { try { registerBot(this.registryDir, this.nickname, this.id.me?.publickey, { level: this.level }) } catch (_) {} }
  _reloadRegistry () {
    if (!this.registryDir) return
    this.botPubkeys = loadBotPubkeys(this.registryDir)
    this.botMeta = loadBotMeta(this.registryDir)
  }
  _hostLevel (pubkey) { return this.botMeta.get(pubkey)?.level }

  /** ¿Esta pubkey es de un bot de la flota? (si no está en el registro → humano) */
  _isBot (pk) {
    if (!pk) return false
    if (this.botPubkeys.has(pk)) return true
    this._reloadRegistry() // posible carrera: releer antes de concluir que es humano
    return this.botPubkeys.has(pk)
  }

  _seatIds (st) { return Object.keys(st?.seats || {}) }
  _occupied (st) { return this._seatIds(st).filter(id => st.seats[id].occupied) }
  _openCount (st) { return this._seatIds(st).filter(id => !st.seats[id].occupied).length }
  _mySeat () { return this.room?.mySeat || null }

  // ───────────────────────── HOST ─────────────────────────
  async _openRoom () {
    if (this._stopped || this.role !== 'host') return
    if (this._pauseTimer) { clearTimeout(this._pauseTimer); this._pauseTimer = null }
    // Soltar la sala anterior SIN que su 'closed' dispare otra reapertura.
    const old = this.room
    this.room = null
    if (old) { try { await old.leave() } catch (_) {} }

    const room = await this.lobby.createRoom({ playerName: this.nickname })
    this.room = room
    const ids = this._seatIds(room.state)
    // En 2: asiento al azar (variedad). En 4: tomo el primero; fillers/humano el resto.
    const seat = this.tableSize === 2 ? ids[Math.random() < 0.5 ? 0 : 1] : ids[0]
    room.takeSeat(seat)
    room.setReady(true)
    this._bind(room)
    this.log(`mesa de ${this.tableSize} abierta (${room.roomId?.slice(0, 8)}…), asiento ${seat}, motor ${this.engine?.name || '?'} — espero ${this.tableSize === 2 ? 'rival' : 'jugadores'}`)
    this._republish()
    this._onUpdate()
  }

  _republish () {
    if (this._stopped || !this.room || this.role !== 'host') return
    try {
      this.lobby.transport.publish(this.discoveryChannel(this.gameId), { name: this.nickname, gameType: this.gameId })
      if (this.room.roomId) this.lobby.transport.publish(this.roomChannel(this.gameId, this.room.roomId))
    } catch (_) {}
  }

  _maybeStart (st) {
    if (st.status !== 'waiting') return
    const occ = this._occupied(st)
    if (occ.length !== this.tableSize) return
    // OJO: NO exigir `seats[id].ready`. En esta app sentarse YA es estar listo
    // (la app hostea con start:'full', sin paso de "listo", y su UI NUNCA llama
    // setReady). Los humanos invitados quedan con ready:false para siempre, así
    // que pedir ready aquí dejaba la mesa colgada en "Empezando…". Basta con que
    // esté completa y haya ≥1 humano.
    const humans = occ.filter(id => !this._isBot(st.seats[id].pubkey))
    if (humans.length < 1) return // NUNCA arrancar sin un humano
    try {
      this.setPendingConfig({ activeSeats: occ }) // orden p1..p4 → equipos {p1,p3} vs {p2,p4}
      const ok = this.room.start()
      this.log(`arranco partida de ${this.tableSize} (humanos: ${humans.length})${ok ? '' : ' (start rechazado)'}`)
    } catch (e) { this.log('start err', e.message) }
  }

  // ───────────────────────── FILLER ─────────────────────────
  async _scan () {
    if (this._stopped || this.role !== 'filler') return
    // Ya estoy (o estoy resolviendo) una sala: el handler 'update' decide el asiento.
    if (this.room) return

    let rooms = []
    try { rooms = await this.lobby.listRooms({ timeout: 1200 }) } catch (_) { return }
    this._reloadRegistry()
    // Mesas de 4, de la flota, en espera, con ≥2 libres (al sentarme deja ≥1 al humano)
    // y del MISMO nivel que yo (no mezclar mesa normal con difícil).
    const cands = rooms
      .filter(r => r.max === 4 && r.status === 'waiting' && r.openSeats >= 2 && this._isBot(r.hostPubkey) &&
        this._hostLevel(r.hostPubkey) === this.level)
      .sort((a, b) => a.openSeats - b.openSeats) // completar mesas existentes primero
    const pick = cands[0]
    if (!pick) return

    try {
      // El estado de asientos NO está listo apenas resuelve joinRoom: me siento en el
      // handler 'update', cuando ya conozco los asientos (ver _onUpdate, rama filler).
      const room = await this.lobby.joinRoom(pick.roomId, { playerName: this.nickname })
      this.room = room
      this._claiming = false
      this._bind(room)
      this.log(`uniéndome a mesa de la flota (${pick.roomId?.slice(0, 8)}…)…`)
      this._onUpdate() // por si el estado ya llegó
    } catch (e) { this.log('join err', e.message); this.room = null }
  }

  /** Filler ya unido a una sala en espera: toma asiento (dejando ≥1 al humano) o se retira. */
  _fillerManageSeat (st) {
    if (this._seatIds(st).length === 0) return // estado de asientos aún no sincronizado
    const open = this._openCount(st)
    if (!this._mySeat()) {
      if (open >= 2 && !this._claiming) {
        this._claiming = true
        const ok = this.room.takeSeat() // primer asiento libre
        if (ok) {
          this.room.setReady(true)
          setTimeout(() => { if (this._mySeat()) this.log(`me siento en ${this._mySeat()}, listo — espero al humano`) }, 600)
        }
        // si el asiento no "prende" (carrera con otro filler), reintentar luego
        setTimeout(() => { if (!this._mySeat()) this._claiming = false }, 1500)
      } else if (open <= 1) {
        // No queda lugar dejándole sitio al humano → busco otra mesa.
        this._afterLeaveRescan()
      }
      return
    }
    // Ya sentado: red de seguridad — si la mesa quedó LLENA de puros bots (carrera),
    // uno se retira para que entre una persona. Jitter → cede sólo uno.
    if (open === 0 && this._occupied(st).every(id => this._isBot(st.seats[id].pubkey))) {
      setTimeout(() => {
        const s2 = this.room?.state
        if (s2 && s2.status === 'waiting' && this._openCount(s2) === 0 && this._mySeat() &&
            this._occupied(s2).every(id => this._isBot(s2.seats[id].pubkey))) {
          this.log('mesa llena de bots → me retiro para dejar entrar a un humano')
          this._afterLeaveRescan()
        }
      }, randInt(500, 4000))
    }
  }

  // ───────────────────────── común ─────────────────────────
  _bind (room) {
    room.on('update', () => { if (this.room === room) this._onUpdate() })
    room.on('state', () => { if (this.room === room) this._onUpdate() })
    room.on('ended', () => { if (this.room === room) this._onEnded() })
    room.on('closed', () => { if (this.room === room) this._onClosed() })
  }

  async _onUpdate () {
    const r = this.room
    if (!r || this._stopped) return
    // COALESCING: mientras "pienso" (await sleep + envío de acción) pueden llegar
    // updates que se perderían — sobre todo el SÍNCRONO de mi propia acción cuando
    // soy host (room.action() → _applyAction → emit('update') corre RE-ENTRANTE con
    // `_thinking` aún true), pero también el de otro jugador que actúa durante mi
    // sleep. Cualquiera de esos marca _pending y, al terminar el ciclo, reproceso el
    // estado MÁS NUEVO. Sin esto, tras un robo válido (el turno vuelve a mí) el bot
    // quedaba colgado: el "ahora te toca" llegaba en el update descartado.
    if (this._thinking) { this._pending = true; return }
    const st = r.state
    if (!st) return

    // Filler: tomar/ceder asiento según el estado de la mesa.
    if (this.role === 'filler' && st.status === 'waiting') { this._fillerManageSeat(st); return }

    // Host: ¿arrancar?
    if (this.role === 'host') this._maybeStart(st)

    // Alguien se desconectó a mitad (onSeatVacated:'pause').
    if (st.status === 'paused') {
      if (this.role === 'host' && !this._pauseTimer) {
        this._pauseTimer = setTimeout(() => { this._pauseTimer = null; this._reopenSoon('pause-timeout') }, PAUSE_REOPEN_MS)
      }
      return
    } else if (this._pauseTimer) { clearTimeout(this._pauseTimer); this._pauseTimer = null }

    // Juego: en 'draw' cada jugador corta por la data (elige carta boca abajo);
    // en 'claim' cualquiera roba la caída; en 'play' cualquiera roba la
    // continuación (carry) y, si no hay carry que robar, juega quien tiene el turno.
    const seat = this._mySeat()
    if (st.status === 'playing' && st.game && seat) {
      const g = st.game
      if (g.phase === 'draw' || g.phase === 'claim' || g.phase === 'play') {
        this._thinking = true
        this._pending = false // sólo cuentan los updates que lleguen DESDE ahora
        try {
          if (g.phase === 'draw') await this._tryCut()
          else if (g.phase === 'claim') await this._tryRob()
          else {
            const robbed = g.carry ? await this._tryCarryRob() : false
            if (!robbed && g.turn === seat) await this._playTurn()
          }
        } catch (e) { this.log('act err', e.message) } finally { this._thinking = false }
        // ¿Avanzó el estado mientras pensaba? Reproceso el más nuevo. Los guards de
        // fase/turno/ventana cortan la cadena en cuanto no queda nada que hacer.
        if (this._pending && !this._stopped) {
          this._pending = false
          Promise.resolve().then(() => this._onUpdate()).catch(() => {})
        }
      }
    }
  }

  async _playTurn () {
    const seat = this._mySeat()
    const g = this.room?.state?.game
    if (!g || this.room.state.status !== 'playing' || g.phase !== 'play' || g.turn !== seat) return false
    const move = await this.engine.play(this.rules, g) // { card, captured }
    if (!move) return false
    await sleep(randInt(MOVE_THINK_MIN, MOVE_THINK_MAX)) // "pensar"
    if (this._stopped) return false
    const cur = this.room?.state // revalidar que sigue siendo mi turno en fase play
    if (!cur || cur.status !== 'playing' || cur.game?.phase !== 'play' || cur.game?.turn !== seat) return false
    const captured = move.captured || []
    this.room.action({ type: 'play', card: move.card, captured })
    this.log(captured.length ? `levanto con ${move.card} (+${captured.length})` : `boto ${move.card}`)
    return true
  }

  /** Corte por la data (fase 'draw'): escojo una carta boca abajo si aún no lo hice. */
  async _tryCut () {
    const g = this.room?.state?.game
    if (!g || this.room.state.status !== 'playing' || g.phase !== 'draw') return false
    if (g.draw?.myPick) return false // ya escogí
    const cut = await this.engine.cut(this.rules, g) // { index } | null
    if (!cut || cut.index == null) return false
    await sleep(randInt(900, 3500)) // "pensar"; jitter → no cortan todos a la vez
    if (this._stopped) return false
    const cur = this.room?.state // revalidar: sigo en corte y sin haber escogido
    if (!cur || cur.status !== 'playing' || cur.game?.phase !== 'draw' || cur.game?.draw?.myPick) return false
    // el índice elegido pudo quedar tomado por otro mientras pensaba → reelegir
    const taken = new Set(cur.game.draw?.takenIndexes || [])
    let index = cut.index
    if (taken.has(index)) {
      const re = await this.engine.cut(this.rules, cur.game)
      if (!re || re.index == null) return false
      index = re.index
    }
    this.room.action({ type: 'cut', index })
    this.log('corto por la data')
    return true
  }

  /** Ventana de robo abierta: si puedo levantar la carta dejada, la robo. */
  async _tryRob () {
    const g = this.room?.state?.game
    if (!g || this.room.state.status !== 'playing' || g.phase !== 'claim') return false
    const rob = await this.engine.rob(this.rules, g) // { captured } | null
    if (!rob || !rob.captured?.length) return false
    await sleep(randInt(900, 3500)) // pensar; jitter → no roban todos a la vez
    if (this._stopped) return false
    const cur = this.room?.state // revalidar que la ventana sigue abierta (misma carta)
    if (!cur || cur.status !== 'playing' || cur.game?.phase !== 'claim' || cur.game?.claimCardId !== g.claimCardId) return false
    // claimCardId → si el robo llega tarde (otra carta), el motor lo IGNORA (no falta).
    this.room.action({ type: 'rob', captured: rob.captured, claimCardId: g.claimCardId })
    this.log(`robo la caída (+${rob.captured.length})`)
    return true
  }

  /** Ventana de carry (fase 'play'): roba la continuación colgante de la escalera.
   *  Cualquier asiento puede; el turno NO cambia. Devuelve true si envió el robo. */
  async _tryCarryRob () {
    const g = this.room?.state?.game
    if (!g || this.room.state.status !== 'playing' || g.phase !== 'play' || !g.carry) return false
    const rob = await this.engine.carryRob(this.rules, g) // { captured } | null
    if (!rob || !rob.captured?.length) return false
    await sleep(randInt(800, 3000)) // pensar; jitter → no roban todos a la vez
    if (this._stopped) return false
    const cur = this.room?.state // revalidar que el mismo carry sigue abierto
    if (!cur || cur.status !== 'playing' || cur.game?.phase !== 'play' || cur.game?.carry?.value !== g.carry.value) return false
    // carryValue → si la continuación ya avanzó (6→7), el motor IGNORA el robo (no falta).
    this.room.action({ type: 'rob', captured: rob.captured, carryValue: g.carry.value })
    this.log(`robo la continuación ${g.carry.value} (+${rob.captured.length})`)
    return true
  }

  _onEnded () {
    const res = this.room?.state?.result
    this.log(`partida terminada (${res?.reason || '?'})${res?.winner ? ' — gana ' + res.winner : ''}`)
    if (this.role === 'host') this._reopenSoon('ended')
    else this._afterLeaveRescan()
  }

  _onClosed () {
    this.log('sala cerrada')
    if (this.role === 'host') this._reopenSoon('closed')
    else this._afterLeaveRescan()
  }

  _afterLeaveRescan () {
    const old = this.room
    this.room = null
    if (old) { old.leave().catch(() => {}) }
    setTimeout(() => this._scan().catch(() => {}), randInt(3000, 7000))
  }

  // El host reabre SOLO al terminar/cerrarse la mesa. Una mesa vacía esperando
  // jugadores se queda abierta indefinidamente (no se reabre).
  _reopenSoon (reason = '?') {
    if (this._stopped || this._reopenTimer || this.role !== 'host') return
    this.log(`reabro mesa (motivo: ${reason})`)
    this._reopenTimer = setTimeout(() => {
      this._reopenTimer = null
      this._openRoom().catch(e => this.log('reopen err', e.message))
    }, randInt(4000, 9000))
  }

  async stop () {
    this._stopped = true
    if (this._reopenTimer) clearTimeout(this._reopenTimer)
    if (this._pauseTimer) clearTimeout(this._pauseTimer)
    if (this._presenceTimer) clearInterval(this._presenceTimer)
    if (this._scanTimer) clearInterval(this._scanTimer)
    try { await this.room?.leave() } catch (_) {}
  }
}
