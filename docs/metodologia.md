# Metodología del monitor

Objetivo: detectar cada nuevo mint en Robinhood Chain **antes o durante** su ventana
de GTD/FCFS/WL, y saber en segundos si tenemos (o nos conviene comprar) una llave.

## Flujo (cada pasada)

### 1. Descubrir — ¿qué se está minteando / qué viene?

**Atajo automático:** `node scripts/gen-radar.mjs --write` → `data/radar.md` con todo
lo del feed de NFT Trencher (mints activos/próximos, fases, hype, followers/posts de X).
Luego completar a mano lo de abajo. Revisión manual en este orden:

| Paso | Fuente | Qué se busca |
|---|---|---|
| 1a | **NFT Trencher** (`neverfuckingtrade.com`) | Radar de mints 7 días: fases WL/GTD/FCFS/public, countdowns, hype score |
| 1b | **OpenSea → Robinhood Chain** | "Minting now" / "Minting soon", supply, minted, floor |
| 1c | **Mintera** | Fichas de mint, fases y precios |
| 1d | **NFT Calendar → Robinhood** | Drops anunciados con fecha |
| 1e | **X / Twitter** (búsqueda pública) | Listas de partners que aún no están en marketplaces |

### 2. Investigar elegibilidad — ¿qué colecciones dan acceso?
Para **cada** mint detectado, obtener los **nombres exactos** de las colecciones que
dan GTD / FCFS / WL. Nunca conformarse con etiquetas genéricas:

> ❌ "RH Community", "Top Collections", "Partner WL", "GTD holders"
> ✅ "StonkBrokers · H00dle · Broker Punks · Chain Mancers"

Dónde mirar: tweet de anuncio del proyecto, hilo de colaboraciones, web oficial del
mint, ficha de OpenSea/Mintera, NFT Trencher (a veces lista los holders elegibles).

Si tras buscar en todas las fuentes no se consigue:

```
⚠️ ELIGIBILITY COLLECTIONS NOT YET FOUND
```

y se reintenta en la siguiente pasada (las listas se suelen completar horas antes).

### 3. Cruzar con nuestras llaves
- ¿Tenemos alguna de las colecciones elegibles? → `data/colecciones.json` campo `owned`.
- Si no, ¿alguna elegible está en `data/prioridad-compra.md` y sale a cuenta comprarla
  ahora para entrar en este mint (y en futuros)?
- Comparar coste de la llave vs. valor esperado del mint (floor tras mint × nº de mints).

### 4. Emitir alerta
Usar las plantillas de `docs/formato-alertas.md` (formato NOW o SOON).

### 5. Registrar
Añadir una fila a `data/registro-mints.csv` por cada mint observado, con **todas** las
colecciones elegibles listadas. Esto alimenta el scoring: cada aparición de una
colección en GTD/FCFS/WL sube su utilidad demostrada.

```
node scripts/log-mint.mjs
```

## Cadencia sugerida
- **Barrido rápido**: cada 2–3 h (paso 1 + 2 para mints con ventana < 24 h).
- **Barrido profundo**: 1×/día (todo el flujo + recalcular ranking).
- **Recalcular ranking WL**: 1×/semana → `node scripts/rank.mjs > data/colecciones-wl-utility.md`.
