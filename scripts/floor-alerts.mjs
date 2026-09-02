// Detecta bajadas de floor en las llaves 🥇/🥈/💎 usando data/floor-history.csv.
//
// Uso:
//   node floor-alerts.mjs              // compara el último dato con el de hace 7 días
//   node floor-alerts.mjs --days 3 --drop 12
//     --days N  : ventana de comparación (por defecto 7)
//     --drop P  : umbral de caída en % para avisar (por defecto 15)
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, loadCollections, parseCsv, findCollection } from "./lib/data.mjs";

const argv = process.argv.slice(2);
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? Number(argv[i + 1]) : d; };
const days = opt("--days", 7);
const dropPct = opt("--drop", 15);

const HISTORY = join(ROOT, "data", "floor-history.csv");
if (!existsSync(HISTORY)) {
  console.log("No hay data/floor-history.csv todavía. Corre  node fetch-floors.mjs  para empezar a acumular histórico.");
  process.exit(0);
}
const rows = parseCsv(readFileSync(HISTORY, "utf8"))
  .map((r) => ({ ...r, floor_eth: Number(r.floor_eth), t: Date.parse(r.fecha) }))
  .filter((r) => r.floor_eth > 0)
  .sort((a, b) => a.t - b.t);

const db = loadCollections();
const byCol = new Map();
for (const r of rows) {
  if (!byCol.has(r.coleccion)) byCol.set(r.coleccion, []);
  byCol.get(r.coleccion).push(r);
}

const cut = Date.now() - days * 86400e3;
const alerts = [], stable = [];

for (const [name, hist] of byCol) {
  const c = findCollection(db, name);
  const latest = hist[hist.length - 1];
  // referencia = último dato ANTES de la ventana, o el más antiguo si no hay
  const ref = [...hist].reverse().find((r) => r.t <= cut) || hist[0];
  if (ref === latest) continue;
  const change = ((latest.floor_eth - ref.floor_eth) / ref.floor_eth) * 100;
  const rec = {
    name, prio: c?.priority || "", wl: c?.wl_value ?? "—",
    from: ref.floor_eth, to: latest.floor_eth, change,
    fromDate: ref.fecha, toDate: latest.fecha,
  };
  if (change <= -dropPct) alerts.push(rec);
  else stable.push(rec);
}
alerts.sort((a, b) => a.change - b.change);

const money = ["🥇", "🥈", "💎", "👑"];
console.log(`# 📉 FLOOR ALERTS — caídas ≥ ${dropPct}% en ${days} días\n`);
if (!alerts.length) {
  console.log("Sin caídas relevantes.");
} else {
  console.log("| Colección | Prio | wl_value | Floor antes | Floor ahora | Δ | Ventana |");
  console.log("|---|:--:|:--:|--:|--:|--:|---|");
  for (const a of alerts) {
    const buy = money.includes(a.prio) ? "  🛒 oportunidad de compra" : "";
    console.log(`| ${a.name}${buy} | ${a.prio} | ${a.wl} | ${a.from} ETH | ${a.to} ETH | ${a.change.toFixed(0)}% | ${a.fromDate} → ${a.toDate} |`);
  }
}

const ups = stable.filter((s) => s.change >= dropPct).sort((a, b) => b.change - a.change);
if (ups.length) {
  console.log(`\n## 📈 Subidas ≥ ${dropPct}% (info)\n`);
  for (const u of ups) console.log(`- ${u.name}: +${u.change.toFixed(0)}%  (${u.from} → ${u.to} ETH)`);
}
