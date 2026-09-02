# Monitor MINTS — Robinhood Chain

Sistema para detectar nuevos minteos en **Robinhood Chain** y decidir rápido si
tenemos (o nos interesa comprar) una **llave** que dé acceso a **GTD / FCFS / WL**.

## Qué hay aquí

```
Monitor MINTS/
├── README.md                      ← este archivo
├── docs/
│   ├── metodologia.md             ← el flujo de trabajo del monitor (paso a paso)
│   ├── formato-alertas.md         ← plantillas de alerta (NOW / SOON)
│   ├── fuentes.md                 ← fuentes públicas + URLs
│   └── scoring-wl-utility.md      ← cómo se puntúa una colección como "llave"
├── data/
│   ├── colecciones.json           ← FUENTE DE VERDAD (estructurada, la usa el script)
│   ├── colecciones-wl-utility.md  ← ranking maestro legible (se regenera)
│   ├── prioridad-compra.md        ← lista de compra por tiers (juicio propio)
│   └── registro-mints.csv         ← log de cada mint observado (alimenta el scoring)
├── prompts/
│   └── prompt-monitor.md          ← prompt reutilizable para ChatGPT / Claude
├── SETUP.md                       ← qué claves/datos hacen falta para la automatización
└── scripts/                       ← automatización (Node.js ≥18, sin dependencias)
    ├── gen-radar.mjs              ← radar de mints + popularidad (SIN claves)
    ├── fetch-floors.mjs          ← floors desde OpenSea + histórico
    ├── floor-alerts.mjs          ← avisa de bajadas de floor en las llaves
    ├── rank.mjs                  ← ranking maestro de llaves WL/GTD/FCFS
    ├── log-mint.mjs              ← registra un mint y sube contadores
    ├── x-popularity.mjs          ← ficha de X (opcional, con token)
    └── lib/{data,trencher}.mjs
```

## Uso rápido

```bash
cd scripts
node gen-radar.mjs --write     # → data/radar.md : próximos mints, fases, popularidad
node fetch-floors.mjs          # floors de las llaves (necesita OPENSEA_API_KEY)
node floor-alerts.mjs          # bajadas de floor
node rank.mjs --write          # → data/colecciones-wl-utility.md : ranking de llaves
```

1. **Descubrir mints**: `gen-radar.mjs` (feed de NFT Trencher) + OpenSea + Mintera.
2. **Investigar elegibilidad**: para cada mint, buscar los **nombres exactos** de las
   colecciones que dan GTD/FCFS/WL (X, web oficial, anuncios de partners). Esto es manual.
3. **Cruzar con nuestras llaves**: ¿tenemos alguna? ¿Merece la pena comprarla?
   Ver `data/colecciones-wl-utility.md` y `data/prioridad-compra.md`.
4. **Registrar**: `node log-mint.mjs mint.json`. Cada aparición de una colección en
   GTD/FCFS/WL sube su puntuación de utilidad.

**Para activar floors/alertas**: ver `SETUP.md`.

## Regla de oro

Nunca conformarse con "RH Community", "Top Collections", "Partner WL" o "GTD" a secas.
Hay que obtener los **nombres concretos** de las colecciones. Si no se consigue:

```
⚠️ ELIGIBILITY COLLECTIONS NOT YET FOUND — reintentar en la siguiente comprobación
```
