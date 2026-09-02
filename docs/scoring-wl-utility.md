# Scoring — utilidad de una colección como llave

Dos números por colección. No mezclarlos.

## 1. `wl_value` (0–10) — criterio editorial
"Cómo de buena es esta llave **en relación a su precio de entrada**."

- 10 = mejor relación utilidad/coste (llave que aparece mucho y cuesta poco).
- No mide potencial de inversión ni floor futuro.
- Se siembra con research (ChatGPT/manual) y se ajusta a mano cuando cambia el floor
  o la evidencia (`registro-mints.csv`).

Guía rápida:
| wl_value | Significado |
|---:|---|
| 9–10 | Comprar ya si no la tenemos |
| 8–8.9 | Muy buena, comprar si el presupuesto lo permite |
| 6–7.9 | Útil pero cara para lo que aporta |
| < 6 | Solo si se quiere por otra razón (colección, flip) |

## 2. Evidencia dura — contadores `gtd` / `fcfs` / `wl`
Número de mints registrados en `registro-mints.csv` en los que la colección apareció
como elegible para esa fase. Los incrementa `scripts/log-mint.mjs`.

### Utilidad demostrada (la calcula `rank.mjs`)
```
utilidad_demostrada = 1.0*gtd + 0.6*fcfs + 0.4*wl
```
Ponderación: GTD (acceso garantizado) vale más que FCFS, que vale más que WL genérica.

### Coste-eficiencia (cross-check data-driven)
```
coste_eficiencia = utilidad_demostrada / floor_eth
```
Sirve para detectar llaves infravaloradas: si `coste_eficiencia` es alta pero
`wl_value` es bajo → revisar al alza el `wl_value`. Y viceversa.

## Decaimiento temporal (opcional)
Al recalcular semanalmente, se puede aplicar peso 0.9 a apariciones de hace > 60 días
para que el ranking refleje qué colecciones son llave **ahora**. Implementado como flag
`--decay` en `rank.mjs`.

## Tiers de prioridad de compra
`priority` en `colecciones.json`:
- 👑 = la llave más potente, precio prohibitivo (no comprar salvo capital alto)
- 💎 = top-tier, cara — comprar solo con convicción
- 🥇 = mejor relación calidad/precio — objetivo de compra principal
- 🥈 = buena, segundo nivel de compra
- (vacío) = long tail, no es objetivo de compra

## Flujo de actualización
1. Cada mint → `log-mint.mjs` (sube contadores).
2. Semanal → `rank.mjs` regenera `data/colecciones-wl-utility.md`.
3. Revisar discrepancias wl_value ↔ coste_eficiencia y ajustar `wl_value` a mano.
4. Actualizar floors con `fetch-floors.mjs` antes de decisiones de compra.
