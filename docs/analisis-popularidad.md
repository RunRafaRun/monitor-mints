# Análisis de popularidad de un proyecto en fase WL/GTD

Para cada proyecto que entra en fase de allowlist, estimar su "hype real" antes de
decidir si merece la pena conseguir la WL o comprar una llave.

## Ficha de popularidad

```
📊 <PROYECTO> — POPULARITY CHECK
Cuenta X: @<handle>  ·  creada: <mes/año>
Seguidores: 12,400  (↑ ~800 / 7d)
Posts (30d): 41  ·  ritmo: ~1.4/día
Engagement medio (últimos 10 posts): 320 likes · 45 RT · 60 replies
Engagement rate: 3.4 %   → 🟢 comunidad activa
Discord: ~6,800 miembros (si accesible)
Mint velocity previa (si tienen otra colección): sold out en 12 min → 🟢
Floor de colecciones previas: estable / +  → 🟢

VEREDICTO: 🟢 ALTO  /  🟡 MEDIO  /  🔴 BAJO / SOSPECHOSO
```

## Umbrales orientativos

| Métrica | 🔴 Bajo | 🟡 Medio | 🟢 Alto |
|---|---|---|---|
| Seguidores X | < 2k | 2k–10k | > 10k |
| Crecimiento 7d | plano / negativo | < 5 % | > 5 % |
| Posts 30d | < 8 | 8–30 | > 30 |
| Engagement rate | < 1 % | 1–2 % | > 2 % |
| Antigüedad cuenta | < 1 mes | 1–4 meses | > 4 meses |
| Discord | < 1k | 1k–5k | > 5k |
| Mint velocity previa | horas/días | < 1 h | < 15 min |

## Señales de alarma (🔴 aunque los números cuadren)
- Ratio seguidores/engagement muy desalineado (posible compra de followers).
- Cuenta creada hace días.
- Replies llenas de bots / mismas frases.
- Sin colección previa y floor objetivo agresivo.
- Equipo anónimo + sin roadmap + solo "FREE MINT" como gancho.

## Cómo obtener los datos
- **Manual**: abrir el perfil de X, mirar seguidores, últimos posts, hacer media a ojo.
- **Semiautomático (Fase 2)**: `scripts/x-popularity.mjs @handle` con `X_BEARER_TOKEN`
  (API v2: `users/by/username`, `tweets` con `public_metrics`). Sin token, el script
  deja la ficha en blanco para rellenar a mano.

## Uso en la decisión
- 🟢 ALTO + tenemos llave → prioridad máxima, preparar wallet.
- 🟢 ALTO + no tenemos llave → evaluar compra de llave en `prioridad-compra.md`.
- 🟡 MEDIO → solo si la llave ya la tenemos (coste 0).
- 🔴 BAJO → ignorar salvo mint gratis y trivial de reclamar.
