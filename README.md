# dotrino-bots

> **Parte del ecosistema [Dotrino](https://dotrino.com).** Dotrino es un ecosistema de aplicaciones centradas en la privacidad de los datos: tu información es tuya, y las decisiones sobre ella también — qué compartes, con quién, cuándo y por qué. Sin anuncios, sin cookies, sin rastreo de datos, sin vender tu identidad a nadie.

Colección de **bots headless** que simulan usuarios reales en las apps del
ecosistema Dotrino. Cada bot:

- **es un "usuario" distinto y estable**: identidad propia (clave ECDSA P-256
  del vault) persistida en `identities/<app>/<nombre>/`. Reabrir = el mismo
  usuario.
- **usa las herramientas oficiales del ecosistema** (no reimplementa el
  protocolo): identidad con `@dotrino/identity`, transporte con
  `@dotrino/proxy-client` contra `wss://proxy.dotrino.com`.
- **tiene cerebro DeepSeek**: las decisiones se resuelven programáticamente; el
  modelo sólo genera el texto de conversación y resuelve elecciones sin regla.
- **se comporta como humano**: pausas de "pensar" y "tipear" con jitter, huecos
  variables entre acciones.
- **no afecta la analítica**: ver _GoatCounter_ abajo.

## Cómo funciona el "headless" (identidad y store sin navegador)

En las apps web, identidad y store son **iframes** (`id.dotrino.com`,
`store.dotrino.com`) que hablan por `postMessage`. Para correr sin navegador,
el núcleo del vault se extrajo a un módulo runtime-agnóstico
(`dotrino-identity/vault/core.js`) que consumen **tanto el iframe como un
adaptador Node** (`@dotrino/identity/node`). La criptografía es
**byte-idéntica** a la del navegador (mismo core), así que un bot Node es
plenamente interoperable con usuarios reales: firmas verificables por el proxy y
el `identify`, y cifrado E2E (ECDH+AES-GCM) descifrable por la app web y
viceversa.

El transporte usa el cliente oficial del proxy tal cual, inyectándole los
globals que espera del navegador: `WebSocket` (paquete `ws`) y un `localStorage`
respaldado en archivo (para el keypair de transporte, propio de cada bot).

## Uso

```bash
npm install

# 2 bots del pool conversando en #general
node src/run.js --app chat --room general --count 2

# bots con nombres concretos (reusan su identidad entre corridas)
node src/run.js --app chat --room demo --names Lucia,Mateo,Sofia
```

Opciones: `--app` (default `chat`), `--room` (default `general`), `--count`
(default 2), `--names a,b,c` (override del pool). `Ctrl-C` los detiene
(unpublish + cierre limpio).

Cada bot corre en su **propio proceso** (`fork`), aislando identidad, keypair de
transporte y singletons de módulo.

## Tópicos actuales (feed de noticias)

Para que las charlas suenen actuales, los bots siembran temas con **titulares
reales** vía RSS público (sin API key): Google News es-AR (general, tecnología,
espectáculos, deportes). El feed se consulta **al iniciar** y se refresca cada
**12 h**; las noticias entran **sólo cuando la charla se traba o muere** (no en
la charla normal), y DeepSeek las reformula con el estilo del personaje — nunca
las pega como titular.

El fetch lo hace el proceso Node (no el front): no toca privacidad de usuarios
ni dispara GoatCounter. Si el feed falla, el bot cae al pivote por palabra del
último mensaje. Categorías configurables por bot con `BOT_TOPICS` (CSV de
`general,tech,entertainment,sports`; vacío = todas). Ver `src/core/topics.js`.

## Producción con PM2

Cada bot corre como una **app PM2 independiente** (restart, logs y monitoreo
propios), todas bajo el namespace `ccbots`.

```bash
# 1) generar la flota (escribe bots.config.json)
node src/gen-ecosystem.js --app chat --room general --count 3
#   o nombres concretos:  --names Lucia,Mateo,Sofia
#   o sumar a una flota existente:  --room sala2 --count 2 --append

# 2) arrancar / operar
npx pm2 start ecosystem.config.cjs
npx pm2 status
npx pm2 logs ccbots
npx pm2 restart ccbots
npx pm2 stop ccbots
npx pm2 delete ccbots          # borra SOLO los bots, no tus otras apps PM2

# 3) (opcional) arranque al boot
npx pm2 save && npx pm2 startup
```

`ecosystem.config.cjs` lee `bots.config.json`; si no existe, usa una flota por
defecto de 2 bots en `#general`. Ajustes por bot: `autorestart`,
`restart_delay` (evita reconexión en bucle), `max_memory_restart`,
`kill_timeout` (deja completar el unpublish + cierre limpio). Logs en `logs/`.

También están los scripts npm: `npm run pm2:gen -- --count 3`, `pm2:start`,
`pm2:logs`, `pm2:stop`, `pm2:restart`, `pm2:delete`, `pm2:status`.

## Configuración

`DEEPSEEK_API_KEY` se lee del `.env` de la raíz del ecosistema (un nivel arriba)
o de `process.env`. Sin ella, los bots siguen vivos con respuestas de reserva.
`PROXY_URL` opcional (default `wss://proxy.dotrino.com`).

## Por qué NO afectan a GoatCounter

GoatCounter es analítica **del front-end**: un script que se ejecuta en el
navegador al cargar el HTML de la app. Los bots son Node headless y **no cargan
la app ni su HTML/JS** — hablan el protocolo del proxy/identidad directamente.
Por eso nunca invocan el script de `goat.dotrino.com` y **no generan
pageviews ni conteos**, sin necesidad de bloquear nada. (Este es un beneficio de
la arquitectura Node sobre un navegador headless, que sí dispararía la
analítica.)

## Estructura

```
ecosystem.config.cjs  config PM2 (una app por bot, namespace ccbots)
bots.config.json      flota generada (gitignored)
src/
  run.js            runner standalone: levanta N bots (un proceso por bot)
  gen-ecosystem.js  genera bots.config.json para PM2
  bot-process.js    arranque de UN bot (identidad + transporte + cerebro + bot)
  core/
    env.js          carga .env (DEEPSEEK_API_KEY, PROXY_URL)
    transport.js    cliente del proxy con shims ws/localStorage + identify firmado
    brain.js        cerebro DeepSeek (composeChat, decide) con reserva
    human.js        latencias humanas (pensar, tipear, huecos)
    personas.js     pool de nombres + personajes
  bots/
    chat-bot.js     bot de simple-websocket-chat (protocolo CHAT_ENC E2E)
identities/         identidad persistida por bot (gitignored)
```

## Bot de ajedrez (`--app chess`)

HOSTEA una sala pública con `@dotrino/lobby` (corre el motor
oficial de `simple-websocket-chess`, reusado sin reimplementar), toma un asiento
y deja el otro libre. Cuando un humano se une y se sienta, el lobby arranca la
partida y el bot juega con latencia humana (~2–9s por jugada). La selección de
jugada es 100% programática (mate > captura > jaque > aleatorio); no usa DeepSeek.
Al terminar la partida reabre una sala nueva: **siempre hay una sala pública
abierta**.

```bash
node src/run.js --app chess --names Diego,Valentina   # 2 hosts = más disponibilidad
# o en PM2:
node src/gen-ecosystem.js --app chess --names Diego,Valentina --append
npx pm2 start ecosystem.config.cjs
```

El motor se carga de `../simple-websocket-chess` (configurable con
`CHESS_APP_DIR`). Reusa `chessRules.js` + `chessAdapter.js` (puros, Node-OK);
`getAlgebraicNotation` se omite (notación de historial vacía, el juego funciona
igual).

> Nota: el descubrimiento del lobby dependía de un fix en
> `@dotrino/proxy-client` 0.6.1 — `buildSignedChannel` ahora
> trata `name`/`publickey` como autoritativos (antes el `{name}` del lobby pisaba
> la clave del canal y nadie encontraba la sala).

## Bot de cuarenta / 40 (`--app cuarenta`)

El **40** tiene mesas de **2** y de **4** jugadores. Como en el ajedrez, los bots
**hostean y esperan**: abren mesas públicas con `@dotrino/lobby`
(corren el motor oficial de `cuarenta`, reusado sin reimplementar) y **nunca
arrancan sin un humano sentado**. Cada bot juega **un asiento** (1 identidad = 1
peer); la decisión es 100% programática (heurística), sin DeepSeek.

Reglas vigentes (captura **manual**): al tirar, el jugador SELECCIONA las cartas
que levanta; el bot busca la mejor escalera contigua (peldaño = carta del mismo
`seq` o pareja de numéricas que sumen) y manda `{type:'play', card, captured}`.
Si sólo puede botar, evita botar una carta "levantable" (eso abre la **ventana de
robo** y regala el levante). Durante una ventana de robo (`phase:'claim'`) el bot
**roba** si puede (`{type:'rob', captured}`) — cartón gratis. Nunca selecciona una
combinación inválida (eso sería **falta**: +10 al rival), así que no se autocastiga.

- **Mesa de 2**: el bot juega como **una sola persona** — hostea, toma un asiento
  y espera al rival humano. Al sentarse el humano y marcar listo, arranca.
- **Mesa de 4**: el bot hace de **3 personas** = **3 bots independientes** (1
  `host` + 2 `filler`), cada uno su propia identidad/pubkey. El host abre la mesa;
  los fillers la descubren en el lobby (sólo mesas de 4 **de la flota**, por el
  registro de pubkeys) y rellenan asientos dejando **siempre 1 libre** para el
  humano. El host arranca sólo cuando los 4 asientos están ocupados, todos listos
  y **hay ≥1 jugador que no es de la flota**. Así una mesa de bots se distingue y
  nunca empiezan a jugar entre ellos sin una persona.

Al terminar la partida el host reabre una mesa nueva y los fillers vuelven a
buscar a quién rellenar: **siempre hay mesas abiertas esperando**.

```bash
# flota: 2 mesas de 2 (2 hosts) + 1 mesa de 4 (1 host + 2 fillers) = 5 bots
node src/gen-ecosystem.js --app cuarenta --tables2 2 --tables4 1
npx pm2 start ecosystem.config.cjs

# manual (un rol por corrida; para una mesa de 4 hacen falta 3 corridas/procesos):
node src/run.js --app cuarenta --role host --size 4 --names Lucia
node src/run.js --app cuarenta --role filler --size 4 --names Mateo,Sofia
```

Flags de la flota: `--tables2 N`, `--tables4 M`, `--engine heuristic:N`
(1 fácil, 2 normal, 3 difícil; default `heuristic:2`). El motor de la app se
carga de `../cuarenta` (configurable con `CUARENTA_APP_DIR`); reusa
`cuarentaEngine.js` + `cuarentaRules.js` (puros, Node-OK). Variables por bot:
`BOT_ROLE`, `BOT_TABLE_SIZE`, `BOT_CUARENTA_ENGINE`.

## Añadir un bot para otra app

1. Crear `src/bots/<app>-bot.js` con una clase que hable el protocolo de esa app
   sobre el `transport` (mismos patrones que `chat-bot.js`).
2. Registrarla en el `switch` de `src/bot-process.js`.
3. Reusar `Brain` para texto/decisiones y `human.js` para las latencias.
