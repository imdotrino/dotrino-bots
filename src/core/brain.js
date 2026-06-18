/**
 * Cerebro de los bots: DeepSeek.
 *
 * Filosofía: las decisiones se resuelven PROGRAMÁTICAMENTE siempre que se pueda
 * (ver bots/*.js). El cerebro sólo entra cuando:
 *   - hay que GENERAR conversación (texto natural en personaje), o
 *   - hay una decisión que no se puede resolver con reglas (decide()).
 *
 * Si no hay DEEPSEEK_API_KEY o la API falla, se degrada con respuestas de
 * reserva para que el bot siga "vivo" sin romperse.
 */
import { DEEPSEEK_API_KEY } from './env.js'

const API_URL = 'https://api.deepseek.com/chat/completions'
const MODEL = 'deepseek-chat'

/**
 * Limpia tics del modelo: risas al inicio ("jajaja, …"), prefijos de nombre
 * ("Lucía: …") y comillas que envuelven el mensaje. Si tras limpiar queda
 * vacío, devuelve el original (no romper un mensaje que era sólo una risa).
 */
function sanitizeChat (raw) {
  const orig = String(raw || '').trim()
  let t = orig
  t = t.replace(/^\s*[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]{2,20}:\s*/, '') // "Nombre: "
  t = t.replace(/^\s*(?:j[ajeo]{2,}|je{2,}|ha{2,})[\s,.!…¡¿-]*/i, '') // "jaja, " "jajaja " "jeje…"
  t = t.replace(/^["“'']\s*|\s*["”'']$/g, '') // comillas envolventes
  t = t.trim()
  return (t || orig).slice(0, 200)
}

export class Brain {
  /**
   * @param {Object} opts
   * @param {string} opts.persona  Descripción del personaje del bot (en es).
   * @param {string} [opts.apiKey]
   */
  constructor ({ persona, apiKey = DEEPSEEK_API_KEY } = {}) {
    this.persona = persona || 'una persona común, amable y conversadora'
    this.apiKey = apiKey
    this.enabled = !!apiKey
  }

  async _call (messages, { temperature = 0.9, maxTokens = 120 } = {}) {
    if (!this.enabled) throw new Error('no-deepseek')
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`
      },
      // frequency/presence penalties altos para cortar el eco de frases.
      body: JSON.stringify({
        model: MODEL, messages, temperature, max_tokens: maxTokens, stream: false,
        frequency_penalty: 0.7, presence_penalty: 0.6
      })
    })
    if (!res.ok) throw new Error(`deepseek ${res.status}: ${await res.text().catch(() => '')}`)
    const data = await res.json()
    const text = data?.choices?.[0]?.message?.content?.trim()
    if (!text) throw new Error('deepseek: respuesta vacía')
    return text
  }

  /**
   * Generar un mensaje de chat en personaje, dado el historial reciente y el
   * "modo" conversacional que decide el bot programáticamente.
   *
   * @param {Array<{name:string, text:string, isMe:boolean}>} history
   * @param {string} room
   * @param {Object} [opts]
   * @param {'opener'|'normal'|'shift'|'nudge'|'annoyed'} [opts.mode]
   * @param {string|null} [opts.trigger]     palabra disparadora para cambiar de tema
   * @param {string|null} [opts.targetName]  a quién dirigirse (mensaje normal)
   * @param {boolean} [opts.wantQuestion]    forzar que termine en pregunta
   * @returns {Promise<string>}
   */
  async composeChat (history, room, opts = {}) {
    const { mode = 'normal', trigger = null, targetName = null, wantQuestion = false, headline = null, mentionText = null } = opts
    const sys = [
      `Eres ${this.persona}.`,
      `Estás en una sala de chat llamada "#${room}" con otras personas.`,
      'Escribe UN solo mensaje corto y natural en español (máx ~140 caracteres),',
      'como en un chat informal. No te presentes como bot ni IA, no expliques nada meta.',
      'IMPORTANTE: NO empieces el mensaje con risas ("jaja", "jajaja", "jeje").',
      'NO repitas ni cites entre comillas palabras o frases que ya se dijeron en el chat;',
      'aportá algo NUEVO con tus propias palabras. NO te obsesiones con un mismo tema',
      'ni vuelvas siempre al mismo asunto (p.ej. el mismo animal, la misma anécdota);',
      'variá. Evita las comillas. Nada de emojis recargados; a lo sumo uno ocasional.'
    ].join(' ')

    const convo = history.slice(-10).map(h => `${h.isMe ? 'Tú' : h.name}: ${h.text}`).join('\n')
    const q = wantQuestion
      ? ' Terminá con una pregunta concreta para que alguien te conteste.'
      : ' Hacé una afirmación o comentario; NO termines tu mensaje con una pregunta.'
    let instruction
    switch (mode) {
      case 'opener':
        instruction = 'El chat está callado. Rompé el hielo con algo breve y simpático.' + q
        break
      case 'shift':
        if (headline) {
          instruction = `La charla se trabó o se apagó. Tomá esta noticia actual como disparador: «${headline}». Arrancá un tema NUEVO comentándola con tu estilo, en una línea, breve y natural; NO la pegues como titular ni la cites textual, hablá como en un chat.` + q
        } else {
          instruction = `La charla se está volviendo repetitiva. Enganchá con la palabra «${trigger || ''}» de lo último que se dijo y usala para cambiar a un tema NUEVO y distinto, de forma natural.` + q
        }
        break
      case 'reply':
        instruction = `Te hablaron directamente: «${mentionText || ''}». Contestá ESO de una, respondiendo lo que pregunta o dice. NO hace falta repetir el nombre de quien te habló (ya están conversando, queda raro). Si te pregunta un dato que no tenés, improvisá una respuesta creíble y breve; no lo ignores ni cambies de tema.` + q
        break
      case 'nudge':
        instruction = 'Hiciste una pregunta y nadie respondió todavía. Insistí con ganas, en tono liviano y bromista (tipo "¿hooola? jaja, nadie?").'
        break
      case 'annoyed':
        instruction = 'Hiciste una pregunta y SIGUEN sin contestarte. Mostrá fastidio leve y resignación, breve y con humor seco (tipo "bueno, hablo solo entonces, joya").'
        break
      default:
        instruction = 'Respondé al hilo de forma natural' + (targetName ? `, dirigiéndote a ${targetName}` : '') + '.' + q
    }
    const user = (convo ? `Conversación reciente:\n${convo}\n\n` : '') + instruction
    try {
      const out = await this._call(
        [{ role: 'system', content: sys }, { role: 'user', content: user }],
        { temperature: 0.95, maxTokens: 80 }
      )
      return sanitizeChat(out)
    } catch (e) {
      return this._fallbackChat(history, mode, trigger)
    }
  }

  /**
   * Decidir entre opciones cuando no hay regla programática. Devuelve una de las
   * `options`. Ante fallo, elige al azar (decisión válida igual).
   * @param {string} question
   * @param {string[]} options
   * @returns {Promise<string>}
   */
  async decide (question, options) {
    if (!Array.isArray(options) || options.length === 0) return null
    if (options.length === 1) return options[0]
    try {
      const sys = `Eres ${this.persona}. Responde SOLO con una de las opciones, tal cual, sin explicar.`
      const user = `${question}\nOpciones: ${options.join(' | ')}`
      const out = await this._call(
        [{ role: 'system', content: sys }, { role: 'user', content: user }],
        { temperature: 0.7, maxTokens: 16 }
      )
      const norm = out.trim().toLowerCase()
      return options.find(o => norm.includes(o.toLowerCase())) || options[Math.floor(Math.random() * options.length)]
    } catch (_) {
      return options[Math.floor(Math.random() * options.length)]
    }
  }

  _fallbackChat (history, mode = 'normal', trigger = null) {
    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]
    if (mode === 'nudge') return pick(['¿hooola? jaja nadie?', '¿se cayó el chat o qué?', 'che, ¿alguien ahí?'])
    if (mode === 'annoyed') return pick(['bueno, hablo solo entonces', 'nada, dejá', 'ok, me quedé hablando solo jaja'])
    if (mode === 'shift' && trigger) return pick([`hablando de ${trigger}, ¿vieron lo último?`, `che, lo de ${trigger} me hizo acordar a otra cosa`])
    if (mode === 'opener' || history.length === 0) return pick(['¿qué tal andan?', 'buenas, ¿cómo va todo?', '¿alguien por acá?'])
    return pick(['jaja sí, te entiendo', 'interesante eso, ¿y cómo fue?', 'totalmente de acuerdo', 'no había pensado en eso, ¿vos qué opinás?'])
  }
}
