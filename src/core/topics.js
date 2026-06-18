/**
 * Feed de tópicos actuales para los bots.
 *
 * Baja titulares públicos por RSS (sin API key) y los cachea con TTL largo
 * (12 h). Los bots NO los pegan como titular: se los pasan a DeepSeek como
 * semilla para arrancar un tema con su propio estilo, sólo cuando la charla se
 * traba o muere (inyección de tema fresco).
 *
 * El fetch lo hace el proceso Node, no el front: no toca privacidad de usuarios
 * ni dispara GoatCounter. Si falla la red o el feed, devuelve null y el bot cae
 * al pivote por palabra del último mensaje.
 */

const GN = (topic) =>
  `https://news.google.com/rss/headlines/section/topic/${topic}?hl=es-419&gl=AR&ceid=AR:es`

export const FEEDS = {
  general: 'https://news.google.com/rss?hl=es-419&gl=AR&ceid=AR:es',
  tech: GN('TECHNOLOGY'),
  entertainment: GN('ENTERTAINMENT'),
  sports: GN('SPORTS')
}

export const ALL_CATEGORIES = Object.keys(FEEDS)

const TTL_MS = 12 * 60 * 60 * 1000 // 12 h

function decodeEntities (s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .trim()
}

function parseTitles (xml) {
  const out = []
  const items = xml.match(/<item\b[\s\S]*?<\/item>/gi) || []
  for (const item of items) {
    const m = item.match(/<title>([\s\S]*?)<\/title>/i)
    if (!m) continue
    let t = decodeEntities(m[1])
    // Google News agrega " - Medio" al final; lo quitamos.
    t = t.replace(/\s+-\s+[^-]{2,40}$/, '').trim()
    if (t.length >= 15 && t.length <= 160) out.push(t)
  }
  return out
}

export class TopicFeed {
  /**
   * @param {Object} [opts]
   * @param {string[]} [opts.categories]  subset de ALL_CATEGORIES
   * @param {number} [opts.ttlMs]
   */
  constructor ({ categories = ALL_CATEGORIES, ttlMs = TTL_MS } = {}) {
    this.categories = categories.filter(c => FEEDS[c])
    if (this.categories.length === 0) this.categories = ALL_CATEGORIES
    this.ttlMs = ttlMs
    this._cache = []
    this._fetchedAt = 0
    this._inflight = null
  }

  get stale () { return Date.now() - this._fetchedAt > this.ttlMs }

  async _fetchOne (url) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; dotrino-bots/0.1; +https://dotrino.com)' },
        signal: AbortSignal.timeout(12000)
      })
      if (!res.ok) return []
      return parseTitles(await res.text())
    } catch (_) { return [] }
  }

  /** Refresca el cache (idempotente concurrente). */
  async refresh () {
    if (this._inflight) return this._inflight
    this._inflight = (async () => {
      const lists = await Promise.all(this.categories.map(c => this._fetchOne(FEEDS[c])))
      const merged = [...new Set(lists.flat())]
      if (merged.length) { this._cache = merged; this._fetchedAt = Date.now() }
      this._inflight = null
      return this._cache
    })()
    return this._inflight
  }

  /** Asegura cache fresca (consulta al iniciar y cuando vence el TTL). */
  async warm () { if (this.stale || this._cache.length === 0) await this.refresh() }

  /** Un titular actual al azar, o null si no hay feed disponible. */
  async randomHeadline () {
    await this.warm()
    if (this._cache.length === 0) return null
    return this._cache[Math.floor(Math.random() * this._cache.length)]
  }
}
