# Fuentes

## Descubrimiento de mints
| Fuente | URL | Uso | API |
|---|---|---|---|
| NFT Trencher | https://neverfuckingtrade.com/ | Radar 7 días: fases WL/GTD/FCFS/public, countdown, hype score, followers/posts de X | **Feed público** `https://cdn.neverfuckingtrade.com/feed.html` (HTML estático, sin auth) → lo parsea `scripts/lib/trencher.mjs` |
| Fuente secundaria | — | Lista curada diaria de mints: fases, precio ETH+USD, allocation por fase | API REST (Supabase). Config en `scripts/.env`: `WLMT_URL` + `WLMT_KEY`. Sin config, se ignora. Parser: `scripts/lib/wlmt.mjs`. Se usa solo para cruzar/completar; el dashboard marca `✓✓` los mints que salen en ambas. |
| OpenSea — Robinhood Chain | https://opensea.io/collections/chain/robinhood | Minting now/soon, supply, minted, floor | Sí (`api.opensea.io/v2`, key gratis) |
| Mintera | https://mintera.io/ (verificar dominio) | Fichas de mint, fases, precios | No confirmada |
| NFT Calendar | https://nftcalendar.io/b/robinhood/ | Drops anunciados con fecha | No |
| CoinGecko NFT — Robinhood | https://www.coingecko.com/en/nft/chains/robinhood | Floor + market cap por colección | Sí (plan free limitado) |

## Elegibilidad (nombres de colecciones para GTD/FCFS/WL)
- Cuenta X del proyecto + hilo de "collabs / partners".
- Web oficial del mint (sección allowlist / eligibility).
- Ficha de OpenSea/Mintera (a veces lista holders elegibles).
- NFT Trencher (campo "eligible holders" cuando lo tiene).
- Discord del proyecto (canal announcements) — normalmente requiere sesión.

## Análisis de popularidad
| Métrica | Fuente | Notas |
|---|---|---|
| Seguidores en X | Perfil X del proyecto | Absoluto + ritmo de crecimiento |
| Nº de posts / frecuencia | Perfil X | Actividad reciente (últimos 7/30 días) |
| Likes / RT / replies medios | Últimos ~10 posts | Calcular engagement medio |
| Engagement rate | (likes+RT+replies medios) / seguidores | > 2 % = comunidad activa |
| Antigüedad de la cuenta | Perfil X | Cuentas < 1 mes = riesgo |
| Miembros de Discord | Widget / invite | Si es accesible |
| Velocidad de minteo | OpenSea (minted/supply vs. tiempo) | Sold out rápido = demanda real |
| Tendencia de floor | OpenSea / CoinGecko | Post-mint: sube / plano / dump |

## Claves de API necesarias (Fase 2)
Guardar en `scripts/.env` (nunca commitear):
```
OPENSEA_API_KEY=
COINGECKO_API_KEY=        # opcional
X_BEARER_TOKEN=           # opcional, para métricas de X vía API v2
```

## Limitaciones conocidas
- El feed completo de X no es accesible sin sesión/API: whitelists anunciadas solo en
  tweets poco indexados o Discord privado pueden escaparse.
- Los floors se mueven en minutos: cualquier cifra guardada es una foto, no un dato fijo.
- Nombres de colecciones con typos deliberados (H00dle, pyopyopyopyo) — cuidado al cruzar.
