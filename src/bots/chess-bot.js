/**
 * Bot de ajedrez headless para `simple-websocket-chess`.
 *
 * HOSTEA una sala pública con el paquete @dotrino/lobby (corre
 * el motor oficial de la app, reusado tal cual), toma un asiento y deja el otro
 * libre. Cuando un HUMANO se une y se sienta, el lobby arranca la partida
 * (start:'full') y el bot juega sus turnos con latencia humana. Al terminar
 * (mate/tablas/abandono) reabre una sala nueva: SIEMPRE hay una sala pública
 * abierta esperando rival.
 *
 * La selección de movimiento es 100% programática (heurística del motor); no usa
 * DeepSeek (el ajedrez se resuelve con reglas).
 */
import { sleep, randInt } from '../core/human.js'
import { coord } from '../core/chess-engine.js'
import { registerBot, loadBotPubkeys } from '../core/registry.js'

const MOVE_THINK_MIN = 900    // pausa humana extra (la búsqueda ya consume tiempo)
const MOVE_THINK_MAX = 5000
const PAUSE_REOPEN_MS = 90000 // si el rival se va y no vuelve, reabrir sala

export class ChessBot {
  /**
   * @param {Object} o
   * @param {import('@dotrino/lobby').Lobby} o.lobby
   * @param {Object} o.identity
   * @param {Object} o.engineRules  exports de chessRules.js
   * @param {Function} o.discoveryChannel  (gameId)=>canal de descubrimiento
   * @param {Function} o.roomChannel       (gameId, roomId)=>canal de la sala
   */
  constructor ({ lobby, identity, engineRules, engine, discoveryChannel, roomChannel, registryDir = null, nickname, log = console.log }) {
    this.lobby = lobby
    this.id = identity
    this.rules = engineRules
    this.engine = engine               // motor de jugada (stockfish/minimax/greedy/llm)
    this.discoveryChannel = discoveryChannel
    this.roomChannel = roomChannel
    this.registryDir = registryDir
    this.botPubkeys = new Set() // pubkeys de la flota → no jugar contra bots
    this.nickname = nickname
    this.log = (...a) => log(`[${nickname}]`, ...a)
    this.gameId = 'chess'
    this.room = null
    this.seat = null
    this._stopped = false
    this._thinking = false
    this._reopenTimer = null
    this._pauseTimer = null
    this._presenceTimer = null
  }

  async start () {
    await this.id.setMyNickname(this.nickname)
    this._registerSelf()   // publico mi pubkey en el registro de la flota
    this._reloadRegistry()  // y cargo las de mis compañeros (para no jugar entre bots)
    // El TTL del canal en el proxy es 20 min; re-publicar cada 10 min basta para
    // mantener la sala visible. NO republicar cada pocos segundos: cada publish
    // reordena la lista y dispara 'joined' a los watchers → la app reordena las
    // salas molestamente. El registro de la flota se recarga on-demand al sentarse
    // un rival (_opponentIsBot), no hace falta un timer.
    this._presenceTimer = setInterval(() => this._republish(), 10 * 60 * 1000)
    // Reabrir la sala si la conexión reconecta con token nuevo (cambia el roomId).
    this.lobby.transport.on('reconnect', () => {
      this.log('reconexión → reabro sala pública')
      this._openRoom().catch(e => this.log('reopen err', e.message))
    })
    await this._openRoom()
  }

  _registerSelf () {
    try { registerBot(this.registryDir, this.nickname, this.id.me?.publickey) } catch (_) {}
  }

  _reloadRegistry () {
    if (this.registryDir) this.botPubkeys = loadBotPubkeys(this.registryDir)
  }

  _opponentSeat () { return this.seat === 'white' ? 'black' : 'white' }

  /** ¿El asiento rival está ocupado por un bot de la flota? */
  _opponentIsBot () {
    const seat = this.room?.state?.seats?.[this._opponentSeat()]
    const pk = seat?.pubkey
    if (!pk) return false
    if (this.botPubkeys.has(pk)) return true
    // Posible carrera: releer el registro antes de concluir que NO es bot.
    this._reloadRegistry()
    return this.botPubkeys.has(pk)
  }

  _republish () {
    if (this._stopped || !this.room) return
    try {
      this.lobby.transport.publish(this.discoveryChannel(this.gameId), { name: this.nickname, gameType: this.gameId })
      if (this.room.roomId) this.lobby.transport.publish(this.roomChannel(this.gameId, this.room.roomId))
    } catch (_) {}
  }

  async _openRoom () {
    if (this._stopped) return
    if (this._pauseTimer) { clearTimeout(this._pauseTimer); this._pauseTimer = null }
    // Soltar la sala anterior SIN que su evento 'closed' dispare otra reapertura
    // (this.room = null antes del leave → los handlers obsoletos se ignoran).
    const oldRoom = this.room
    this.room = null
    if (oldRoom) { try { await oldRoom.leave() } catch (_) {} }
    this.seat = Math.random() < 0.5 ? 'white' : 'black'
    const room = await this.lobby.createRoom({ playerName: this.nickname })
    this.room = room
    room.takeSeat(this.seat)
    // Solo la sala ACTUAL puede disparar acciones; eventos de salas viejas se ignoran.
    room.on('update', () => { if (this.room === room) this._onUpdate() })
    room.on('ended', () => { if (this.room === room) this._onEnded() })
    room.on('closed', () => { if (this.room === room) this._reopenSoon('closed') })
    this.log(`sala pública abierta (${room.roomId?.slice(0, 8)}…), juego de ${this.seat} con motor ${this.engine?.name || '?'}, espero rival`)
    this._republish()
    this._onUpdate()
  }

  async _onUpdate () {
    const r = this.room
    if (!r || this._stopped) return
    const st = r.state
    if (!st) return

    // Los bots NO juegan entre ellos: si el asiento rival lo ocupa un bot de la
    // flota, libero la sala (queda abierta para un humano).
    const oppSeat = st.seats?.[this._opponentSeat()]
    if (oppSeat?.pubkey && this._opponentIsBot()) {
      this.log('rival es un bot → no juego entre bots, reabro sala')
      this._reopenSoon('rival-bot')
      return
    }

    // Rival se desconectó a mitad (onSeatVacated:'pause') → reabrir si no vuelve.
    if (st.status === 'paused') {
      if (!this._pauseTimer) {
        this._pauseTimer = setTimeout(() => { this._pauseTimer = null; this._reopenSoon('pause-timeout') }, PAUSE_REOPEN_MS)
      }
      return
    } else if (this._pauseTimer) {
      clearTimeout(this._pauseTimer); this._pauseTimer = null
    }

    if (st.status === 'playing' && st.game && st.game.currentTurn === this.seat && !this._thinking) {
      this._thinking = true
      try { await this._playTurn() } catch (e) { this.log('playTurn err', e.message) } finally { this._thinking = false }
    }
  }

  async _playTurn () {
    const game = this.room?.state?.game
    if (!game || this.room.state.status !== 'playing' || game.currentTurn !== this.seat) return
    const move = await this.engine.bestMove(this.rules, game.board, this.seat, game.moveHistory || [])
    if (!move) return // sin jugadas legales → el motor declarará mate/tablas
    await sleep(randInt(MOVE_THINK_MIN, MOVE_THINK_MAX)) // "pensar"
    if (this._stopped) return
    // Revalidar que sigue siendo mi turno (el estado pudo cambiar).
    const cur = this.room?.state
    if (!cur || cur.status !== 'playing' || cur.game?.currentTurn !== this.seat) return
    this.room.action({ type: 'move', from: move.from, to: move.to, piece: move.piece, captured: move.captured })
    this.log(`muevo ${coord(move.from)}→${coord(move.to)}${move.captured ? ' x' : ''}`)
  }

  _onEnded () {
    const res = this.room?.state?.result
    this.log(`partida terminada (${res?.reason || '?'}): ${res?.winner ? 'gana ' + res.winner : 'tablas'}`)
    this._reopenSoon('ended')
  }

  // Reabrir SOLO cuando la partida termina o la sala se cierra de verdad. Una
  // sala vacía esperando rival se queda abierta INDEFINIDAMENTE (no se reabre).
  _reopenSoon (reason = '?') {
    if (this._stopped || this._reopenTimer) return
    this.log(`reabro sala (motivo: ${reason})`)
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
    try { await this.room?.leave() } catch (_) {}
  }
}
