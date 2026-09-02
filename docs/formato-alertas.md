# Formato de alertas

## A. Radar general (varias colecciones de un vistazo)

```
🚨 ROBINHOOD MINT RADAR — <hora>

🟢 MINTING NOW
Proyecto        Estado          Minted/Supply   Fase / Precio           Floor    Mint→Floor
<name>          🟢 MINTING NOW  1,245 / 3,333   GTD FREE               $1.71    🔥 FREE → $1.71

🔵 MINTING SOON / UPCOMING
Proyecto        Fecha/fase      GTD / WL / FCFS                 Public
<name>          3 Sep           GTD FREE + WL FREE              FREE
```

## B. Ficha de mint (una alerta detallada) — FORMATO OBLIGATORIO

```
🚨 <PROYECTO> — <MINTING NOW | MINTING SOON | 3 Sep 02:00>
Supply: 5,555 · Minted: 1,243

🎟️ GTD:
🔑 Colecciones necesarias: StonkBrokers · H00dle · Broker Punks · ...
Price: FREE

⚡ FCFS:
🔑 Colecciones necesarias: Broker Punks · Chain Mancers · ...
Price: FREE

📋 WL / Allowlist (<nombre de la fase, p.ej. RH Community>):
🔑 Colecciones necesarias: ...
Price: FREE

🌐 PUBLIC: $0.48
📊 Floor: todavía no / $X
📎 Fuente: <url del anuncio / OpenSea / Trencher>

⭐ YOU HAVE A KEY: H00dle ✅        ← si tenemos alguna (owned:true) elegible
💡 BUY TO QUALIFY: Gremlin Cartel (~$19) → entra en GTD    ← si compensa comprarla
```

## C. Cuando no hay datos de elegibilidad

```
🚨 <PROYECTO> — MINTING SOON
Supply: ? · Minted: ?
⚠️ ELIGIBILITY COLLECTIONS NOT YET FOUND
   Buscado en: X, web oficial, OpenSea, Mintera, NFT Trencher — sin nombres concretos.
   Reintento en la próxima pasada.
🌐 PUBLIC: <precio si se conoce>
```

## Reglas
- Si una fase dice solo "GTD" / "Top Collections" / "Partner WL" sin nombres → tratarlo
  como caso C para esa fase, no darlo por bueno.
- Listar **todas** las colecciones elegibles aunque no tengamos ninguna: son evidencia
  para el ranking de `WL Utility`.
- `⭐ YOU HAVE A KEY` solo con colecciones marcadas `owned:true` en `colecciones.json`.
- `💡 BUY TO QUALIFY` solo si la llave está en tier 🥇/🥈 o `wl_value >= 8` y el precio
  es asumible.
