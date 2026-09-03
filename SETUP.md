# SETUP — qué hace falta para la automatización

## 0. Node.js
Comprueba: `node -v` → debe ser ≥ 18. Si no, instala desde https://nodejs.org (LTS).
No hay que instalar nada más: los scripts no tienen dependencias.

## 1. Lo que YA funciona sin claves ✅
```bash
cd "C:\Users\rfernandez\Monitor MINTS\scripts"
node gen-radar.mjs --write
```
Genera `data/radar.md` con próximos mints, fases GTD/FCFS/WL, hype, y **popularidad
de X (followers, posts, antigüedad de la cuenta)** — todo del feed público de NFT
Trencher. Esto ya cubre tus puntos 3 y 4.

## 2. Para floors y alertas de bajada de floor (punto 2) — necesito una clave

### OpenSea API key (gratis, 2 min)
1. Entra en https://docs.opensea.io/reference/api-keys
2. "Request an API key" → rellena el formulario (nombre del proyecto: algo como
   "personal NFT tracker", uso: "portfolio / floor tracking"). Suele aprobarse al momento.
3. Copia la clave.
4. En la carpeta `scripts/`:
   ```bash
   copy .env.example .env
   ```
   Abre `.env` y pon:  `OPENSEA_API_KEY=tu_clave_aqui`

### Los slugs de OpenSea — automático, no tocas nada
```bash
node resolve-slugs.mjs
```
Resuelve solo el slug de cada colección (por contrato si está en el feed, si no
probando candidatos y verificando que sea Robinhood Chain) y lo guarda en
`data/opensea-slugs.json`. Ya viene ejecutado: ~180 slugs resueltos.

Si `fetch-floors.mjs` detecta un floor absurdo (salto > 3×) asume que el slug es de
un **copycat**, **no lo actualiza** y lo lista al final como "dudoso". Solo entonces,
si te interesa esa colección, pásame su URL de OpenSea o bórrala del JSON.

```bash
node fetch-floors.mjs      # guarda floors + histórico (respeta los estimados si el slug falla)
node floor-alerts.mjs      # avisa de caídas
```

## 3. Opcional — métricas de X más finas (`x-popularity.mjs`)
El feed de NFT Trencher ya da followers/posts/antigüedad, así que esto es un extra.
Si lo quieres:
1. https://developer.x.com → cuenta Free.
2. Crea un proyecto/app y copia el **Bearer Token**.
3. En `scripts/.env`:  `X_BEARER_TOKEN=...`

La API Free de X tiene límites bajos (pocas consultas/mes), úsala solo para proyectos
concretos que estés valorando en serio.

## 4. Lo que NO se puede automatizar del todo
Los **nombres exactos de las colecciones elegibles** para GTD/FCFS/WL no están en
ninguna API pública: se anuncian en tweets, la web del mint o Discord. El radar los
deja marcados como `⚠️ ELIGIBILITY COLLECTIONS NOT YET FOUND` y hay que investigarlos
a mano (y registrarlos con `node log-mint.mjs` para que alimenten el ranking).

Si en algún momento quieres esto también automático, haría falta un bot con sesión de
X/Discord (otra liga, con riesgo de baneo).

## El dashboard — dos formas

### A) Interactivo (recomendado) — `servidor.cmd`  /  `node serve.mjs`
Levanta `http://localhost:8787`. Aquí **los checkboxes de "Tengo" se guardan de
verdad** en `data/colecciones.json`, hay botón "Actualizar" y refresca el feed solo
cada 15 min. Deja la ventana negra abierta mientras lo uses (Ctrl+C para parar).

### B) Fichero suelto — `node gen-dashboard.mjs --open`
Genera `data/dashboard.html`, un **HTML 100 % autocontenido** (datos + estilos + JS
embebidos, sin conexión). **Se puede compartir tal cual**: lo mandas por correo/chat y
se abre con doble clic en cualquier ordenador, sin instalar nada.
- Es una foto: los datos son del momento en que lo generaste.
- Los checkboxes de "Tengo" en modo fichero solo se guardan en *ese* navegador
  (no en `colecciones.json`); al marcarlos te enseña el comando para persistirlos.

### Marcar lo que tienes
- En modo servidor: marca los checkboxes de la pestaña **Llaves**. Ya está.
- Por consola:  `node set-owned.mjs "H00dle" "Broker Punks" "Gremlin Cartel"`
  (esa es tu lista completa; `--add` / `--remove` para tocar una sola; `--list` para ver).

### Idioma
Botón **ES | EN** arriba a la derecha, se recuerda por navegador.

### Elegibilidad de un mint (qué llaves pide y si la tienes)
El feed no la trae. Créala a mano en `data/eligibility.json`:
```json
{ "TerminalX": ["H00dle", "Broker Punks"], "Suited Ape Society": ["StonkBrokers"] }
```
El dashboard cruzará esos nombres con tus `owned` y marcará **⭐ TIENES LLAVE** en el radar.

### Plazas confirmadas (🎟️ tengo un spot en una fase)
Pestaña **🎟️ Plazas** del dashboard. Ahí apuntas a mano los proyectos donde ya
tienes plaza para una fase concreta (GTD / FCFS / WL / PUBLIC / TEAM / OG…) y la
cantidad. Es **100 % local a tu navegador** (`localStorage`, igual que los
checkboxes de "Tengo" en modo fichero) — no toca ningún JSON ni se comparte al
mandar el `dashboard.html`.
- El **Radar** marca esos mints con una etiqueta dorada **🎟️ PLAZA GTD ×2 …** en
  la columna Llaves y resalta la fila con borde dorado.
- Si esa fase existe de verdad en el mint, la pastilla se ilumina.
- La casilla **solo mis llaves y plazas** del Radar deja únicamente esas filas.
- Cada plaza puede llevar una **nota** (dónde/cómo la conseguiste).

**Proyecto sin fecha de mint todavía.** Puedes escribir un nombre que no esté en la
lista: la plaza se guarda como **pendiente** (columna Estado: ⏳ *sin fecha de mint*).
En cuanto ese proyecto aparezca en el radar con **el mismo nombre** (comparación sin
mayúsculas ni símbolos) se **asigna solo** y salta un aviso (toast + pitido). Si el
radar lo lista con **otro nombre**, usa el desplegable **"— asignar a un mint —"** de
la columna Estado para enlazarlo a mano. El pie de la tabla cuenta cuántas plazas
siguen pendientes.

### Elegibilidad REAL de tu wallet (🔎 estás en la lista de OpenSea)
Distinto de las Plazas (que apuntas a mano): esto **le pregunta a OpenSea** si tu
wallet está en la lista firmada (GTD / FCFS / WL / presale) de cada drop SeaDrop en
RobinHood / Ethereum / Ink. En el radar sale **🔎 OpenSea: ✅ GTD  ✗ FCFS** en la
columna Llaves (✅ estás · ✗ no · `nº` = wallets en esa lista, sin comprobar la tuya).

Necesita una **sesión de OpenSea** — firmas un mensaje (login OAuth), **NO es una
transacción y no se toca la clave privada**. El token queda en `~/.opensea/auth.json`,
en tu máquina.

- **Con el dashboard en modo servidor** (`servidor.cmd`): botón **🔎 OpenSea ·
  Conectar** en la cabecera → te abre OpenSea, apruebas, y aparece **Actualizar
  elegibilidad**. Nada más que instalar (usa `npx`).
- **Por consola**:
  ```bash
  npm i -g @opensea/cli          # una vez
  opensea login --scopes read:eligibility
  node scripts/fetch-eligibility.mjs
  ```
- `update.mjs` lo lanza solo si detecta sesión (`~/.opensea/auth.json`). Cuando el
  token caduca (~1 h): botón **Reconectar**, o `opensea auth refresh`.
- **Personal**: `data/eligibility-wallet.json` está en `.gitignore` y el modo
  `--public` (la web) lo quita del payload.

## Cómo se actualizan los datos

| Dato | Fuente | Cuándo se actualiza |
|---|---|---|
| Mints, fases, hype, followers/posts de X | feed de NFT Trencher | cada vez que corres `gen-radar` / `gen-dashboard` / `update`; con `serve.mjs` **solo, cada 15 min** y al pulsar **Actualizar** |
| Floors (ETH/$) + histórico | API de OpenSea | solo con `fetch-floors` (o `update`); con `serve.mjs` **solo, cada 60 min** |
| Ranking de llaves | `colecciones.json` | con `rank` (o `update`) |
| "Tengo" (owned) | tú | checkboxes en modo servidor, o `set-owned.mjs` |
| Elegibilidad de un mint | tú | editando `data/eligibility.json` |
| Plazas confirmadas (🎟️) | tú | pestaña **Plazas** del dashboard — local a tu navegador |
| Elegibilidad real de tu wallet (🔎) | API de OpenSea (con sesión) | botón **Actualizar elegibilidad**, o `fetch-eligibility.mjs` / `update.mjs` |

**El fichero suelto `dashboard.html` NO se actualiza solo** — es una foto. Regenéralo.

### Varias redes (RH · ETH · Ink · Base)
El radar recorre esas 4 redes en el feed de NFT Trencher + WLMT. El selector de arriba
del dashboard filtra por red (por defecto **RobinHood**); solo aparecen las redes con
mints o colecciones.

Cada red tiene su fichero de colecciones-llave:
- `data/colecciones.json` — RobinHood (el de siempre)
- `data/colecciones-eth.json` / `-ink.json` / `-base.json` — mismo esquema. Cada
  entrada puede llevar `slug` (el trozo final de `opensea.io/collection/XXX`).

⚠️ `fetch-floors.mjs` y `rank.mjs` **solo tocan `colecciones.json`**: los `floor_eth`
de las redes nuevas se ponen a mano en su JSON por ahora (o se dejan `null` → "—").

### Todo de golpe
```
actualizar.cmd            (doble clic)   ó   node scripts/update.mjs
```
Hace: radar → slugs → floors → alertas → ranking → dashboard.

### Que se actualice solo (sin abrir nada)
Programador de tareas de Windows → nueva tarea básica → cada 1-2 h → acción:
```
Programa:  node
Argumentos:  update.mjs
Iniciar en:  C:\Users\rfernandez\Monitor MINTS\scripts
```
O simplemente deja `servidor.cmd` abierto: se refresca solo mientras esté en marcha.

## Resumen: lo que me tienes que dar
| Para | Qué necesito de ti |
|---|---|
| Floors + alertas | ✅ Ya está: `OPENSEA_API_KEY` puesta. Los slugs se resuelven solos. |
| Marcar lo que ya tienes | Dime qué colecciones posees → pongo `owned:true` en `colecciones.json` |
| Slugs "dudosos" | Solo si te interesa una que `fetch-floors` marcó como copycat: su URL de OpenSea |
| X token | Nada — no hay plan Free ya y el feed de Trencher da followers/posts igual |
| Radar + dashboard | Nada — ya funciona |
