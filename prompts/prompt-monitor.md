# Prompt — Robinhood Mint Radar

Pega esto en ChatGPT / Claude cuando quieras una pasada del monitor. Adjunta
`data/colecciones.json` (o pega `data/colecciones-wl-utility.md`) para el cruce de llaves.

---

Eres mi monitor de mints de **Robinhood Chain**. Haz una pasada ahora.

**1. Descubrir** (con búsqueda web): revisa NFT Trencher (neverfuckingtrade.com),
OpenSea → Robinhood Chain ("minting now" y "minting soon"), Mintera y NFT Calendar.
Lista todos los mints activos o con ventana en las próximas 72 h.

**2. Elegibilidad**: para CADA mint, busca los **nombres exactos** de las colecciones
que dan GTD / FCFS / WL. Fuentes: cuenta de X del proyecto, hilo de collabs, web
oficial del mint, ficha de OpenSea/Mintera. NO aceptes etiquetas genéricas ("RH
Community", "Top Collections", "Partner WL", "GTD holders") — necesito los nombres.
Si no lo consigues para una fase: `⚠️ ELIGIBILITY COLLECTIONS NOT YET FOUND`.

**3. Popularidad** (para mints con hype dudoso): cuenta de X → seguidores, ritmo de
posts (30d), likes/RT/replies medios, engagement rate, antigüedad de la cuenta.
Veredicto 🟢 ALTO / 🟡 MEDIO / 🔴 BAJO. Marca señales de bots o cuenta recién creada.

**4. Cruce con mis llaves**: usa la lista adjunta (`colecciones.json`).
- `⭐ YOU HAVE A KEY: <nombre>` para cada colección elegible con `owned: true`.
- `💡 BUY TO QUALIFY: <nombre> (~$precio)` si una colección elegible tiene
  `priority` 🥇/🥈 o `wl_value ≥ 8` y el precio es asumible.

**5. Floors**: para las llaves implicadas y para el propio proyecto (si ya tiene
mercado), dame el floor actual y si ha bajado > 15 % en 24 h (oportunidad de compra).

**6. Salida**: usa el formato de `docs/formato-alertas.md` — un radar general primero
y luego una ficha detallada por cada mint con GTD/FCFS/WL. Ordena por urgencia
(ventana más próxima primero). Al final, dame las filas CSV listas para pegar en
`registro-mints.csv` (columnas: fecha,proyecto,supply,minted,fase,tipo,precio,
colecciones_elegibles,tengo_llave,floor_post_mint_usd,popularidad,fuente,notas).

Sé conciso. Marca claramente lo que no has podido verificar.
