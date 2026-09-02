# scripts/ — automatización

Node.js ≥ 18, **sin dependencias** (usa `fetch` nativo). No hace falta `npm install`.

## Configuración
```bash
cp .env.example .env      # y rellena las claves que tengas
```
| Clave | Para qué | Necesaria |
|---|---|---|
| `OPENSEA_API_KEY` | floors y su histórico (`fetch-floors.mjs`) | sí, para floors |
| `X_BEARER_TOKEN` | métricas de X en `x-popularity.mjs` | opcional (el feed ya trae followers/posts) |
| `COINGECKO_API_KEY` | — | opcional |

`gen-radar.mjs` **no necesita ninguna clave**: el feed de NFT Trencher es público.

## Comandos

### `gen-dashboard.mjs` — dashboard HTML para el navegador ⭐
```bash
node gen-dashboard.mjs --open     # genera data/dashboard.html y lo abre
```
Un HTML autocontenido con 4 pestañas: 🔥 Radar · 🔑 Llaves · 🛒 Comprar · 📉 Floors.
Tablas ordenables (clic en la cabecera). Relánzalo para refrescar.

### `resolve-slugs.mjs` — resuelve los slugs de OpenSea (automático)
```bash
node resolve-slugs.mjs
```
Rellena `data/opensea-slugs.json` sin intervención. Ya ejecutado (~180 slugs).

### `gen-radar.mjs` — el radar de mints (sin claves)
```bash
node gen-radar.mjs                 # imprime el radar
node gen-radar.mjs --write         # data/radar.md + data/mints-cache.json
node gen-radar.mjs --hours 48      # ventana "UPCOMING" (def. 72 h)
node gen-radar.mjs --by-hype       # ordena "UPCOMING" por hype en vez de por hora
node gen-radar.mjs --min-hype 15   # oculta ruido (hype < 15 y sin X)
```
Descarga `https://cdn.neverfuckingtrade.com/feed.html`, filtra Robinhood Chain y saca:
mints activos / próximos, supply, hype, **followers y posts de X, antigüedad de la
cuenta** (popularidad), fases GTD/FCFS/WL/HOLDER con hora y precio, enlaces (X, web,
OpenSea) y el slug de OpenSea. Deja `⚠️ ELIGIBILITY COLLECTIONS NOT YET FOUND` en cada
fase: los nombres de colecciones elegibles siguen siendo investigación manual.

### `fetch-floors.mjs` — floors de las llaves + histórico
```bash
node fetch-floors.mjs                       # todas las que tengan slug resoluble
node fetch-floors.mjs --only "H00dle,Broker Punks"
node fetch-floors.mjs --set "H00dle=h00dle" # fija un slug a mano
node fetch-floors.mjs --dry                 # no escribe
```
Resuelve el slug de OpenSea por este orden: campo `slug` en `colecciones.json` →
`data/opensea-slugs.json` → `data/mints-cache.json` (lo genera `gen-radar.mjs`).
Escribe `floor_eth`/`floor_usd` en `colecciones.json` y **añade una fila a
`data/floor-history.csv`** cada vez.

### `floor-alerts.mjs` — bajadas de floor
```bash
node floor-alerts.mjs                 # caídas ≥ 15 % en 7 días
node floor-alerts.mjs --days 3 --drop 12
```
Compara el histórico y marca `🛒 oportunidad de compra` en las llaves 🥇/🥈/💎/👑.

### `rank.mjs` — ranking maestro de llaves
```bash
node rank.mjs --write            # data/colecciones-wl-utility.md
node rank.mjs --decay --write    # penaliza apariciones > 60 días
```

### `log-mint.mjs` — registrar un mint observado
```bash
node log-mint.mjs mint.json
echo '{"proyecto":"X","tipo":"GTD","colecciones_elegibles":["H00dle"]}' | node log-mint.mjs -
```
Añade la fila a `registro-mints.csv` y +1 al contador GTD/FCFS/WL de cada colección
elegible reconocida. Formato del JSON: ver cabecera de `log-mint.mjs`.

### `x-popularity.mjs` — ficha de popularidad (opcional)
```bash
node x-popularity.mjs @ProyectoNFT
```
Con `X_BEARER_TOKEN`: seguidores, ritmo de posts, engagement rate. Sin token:
plantilla en blanco (el radar ya trae followers/posts del feed).

## Rutina

**Cada pasada (2–3 h):**
```bash
node gen-radar.mjs --write        # ver qué hay -> data/radar.md
```
**Diaria:**
```bash
node fetch-floors.mjs
node floor-alerts.mjs
```
**Semanal:**
```bash
node rank.mjs --write
```
**Tras cada mint interesante:** `node log-mint.mjs mint.json`

## Nota de fragilidad
`gen-radar.mjs` hace scraping del HTML de NFT Trencher (`lib/trencher.mjs`). Si cambian
el marcado, ajusta los regex de ese archivo. Los campos clave son `<article class="card"
data-*>` y `<div class="gate" title="...">`.
