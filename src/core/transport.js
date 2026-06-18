/**
 * Transporte headless: el cliente OFICIAL del proxy (`@dotrino/
 * proxy-client`) corriendo en Node. No se reimplementa el protocolo; sólo se
 * inyectan los globals que el paquete espera del navegador:
 *   - `WebSocket`  → el paquete `ws`.
 *   - `localStorage` → un shim respaldado en un archivo por bot (para que cada
 *      bot tenga su propio keypair de transporte estable).
 *
 * Además hace el `identify` firmado por el vault (igual que connectionStore.js
 * del messenger): liga el token efímero de la conexión a la pubkey estable del
 * bot, habilitando la cola offline y el direccionamiento por pubkey.
 */
import { PROXY_URL } from './env.js'
import { installNodeGlobals } from './node-globals.js'

/**
 * Crea y conecta el transporte para un bot, y lo identifica con su vault.
 *
 * @param {Object} opts
 * @param {import('@dotrino/identity/node').Identity} opts.identity
 * @param {string} opts.dir   Directorio de persistencia del bot.
 * @param {string} [opts.url] URL del proxy (default: PROXY_URL del .env).
 * @returns {Promise<{ client, token:string, identify():Promise<void> }>}
 */
export async function createTransport ({ identity, dir, url = PROXY_URL }) {
  installNodeGlobals(dir)
  // Import dinámico DESPUÉS de instalar los globals que el paquete usa.
  const { getWebSocketProxyClient } = await import('@dotrino/proxy-client')

  // WebRTC off: los bots usan el proxy como transporte (no hace falta P2P y
  // RTCPeerConnection no existe en Node). Reconexión prácticamente ilimitada:
  // un bot de larga duración no debe rendirse tras 5 intentos.
  const client = getWebSocketProxyClient({
    url, enableWebRTC: false, autoReconnect: true,
    maxReconnectAttempts: 100000, reconnectDelay: 4000
  })

  const token = await client.connect()

  const identify = async () => {
    const publickey = identity.me?.publickey
    if (!publickey || !client.token) return
    const data = { op: 'identify', publickey, token: client.token, ts: Date.now() }
    const { signature } = await identity.signData(data)
    await client.identify({ data, signature })
  }
  await identify()
  // Re-identificar al reconectar (el token cambia).
  client.on('token', () => { identify().catch(() => {}) })

  return { client, token, identify }
}
