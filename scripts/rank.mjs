// Genera el ranking maestro de llaves WL/GTD/FCFS.
// Uso:  node rank.mjs [--decay] [--write]
//   --decay : penaliza apariciones de hace > 60 días (usa registro-mints.csv)
//   --write : sobrescribe data/colecciones-wl-utility.md (si no, imprime a stdout)
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import {
  loadCollections, demonstratedUtility, costEfficiency,
  parseCsv, findCollection, REGISTRO_PATH, RANKING_PATH,
} from "./lib/data.mjs";

const args = new Set(process.argv.slice(2));
const decay = args.has("--decay");
const db = loadCollections();

// Recuento temporal desde el registro (para --decay y para auditar los contadores).
if (existsSync(REGISTRO_PATH)) {
  const rows = parseCsv(readFileSync(REGISTRO_PATH, "utf8"));
  const now = Date.now();
  for (const c of db.collections) c._live = { gtd: 0, fcfs: 0, wl: 0 };
  for (const r of rows) {
    const cols = (r.colecciones_elegibles || "").split(/[·,;|]/).map((s) => s.trim()).filter(Boolean);
    const tipo = (r.tipo || r.fase || "").toUpperCase();
    const ageDays = r.fecha ? (now - Date.parse(r.fecha)) / 86400000 : 0;
    const w = decay && ageDays > 60 ? 0.9 : 1;
    for (const name of cols) {
      const c = findCollection(db, name);
      if (!c) continue;
      if (tipo.includes("GTD")) c._live.gtd += w;
      else if (tipo.includes("FCFS")) c._live.fcfs += w;
      else c._live.wl += w;
    }
  }
  // Si el registro tiene más señal que los contadores, usarla.
  for (const c of db.collections) {
    c.gtd = Math.max(c.gtd || 0, Math.round(c._live.gtd));
    c.fcfs = Math.max(c.fcfs || 0, Math.round(c._live.fcfs));
    c.wl = Math.max(c.wl || 0, Math.round(c._live.wl));
  }
}

const rows = db.collections
  .map((c) => ({
    ...c,
    util: demonstratedUtility(c, { decay }),
    ce: costEfficiency(c),
  }))
  .sort((a, b) => {
    // Orden: wl_value desc (null al final), luego util desc, luego floor asc.
    const av = a.wl_value ?? -1, bv = b.wl_value ?? -1;
    if (bv !== av) return bv - av;
    if (b.util !== a.util) return b.util - a.util;
    return (a.floor_eth ?? 1e9) - (b.floor_eth ?? 1e9);
  });

const fmtUsd = (n) => (n == null ? "—" : "$" + Number(n).toLocaleString("en-US"));
const fmtEth = (n) => (n == null ? "—" : Number(n).toFixed(4) + " ETH");
const flag = (c) => {
  if (c.ce != null && (c.wl_value ?? 0) < 7 && c.ce > 200) return "⬆️ revisar al alza";
  if (c.wl_value != null && c.wl_value >= 9 && c.util === 0) return "🔎 sin evidencia aún";
  return "";
};

let out = `# Colecciones — WL / GTD / FCFS Utility (ranking maestro)

> Generado por \`scripts/rank.mjs\`${decay ? " (--decay)" : ""} · datos: ${db.meta.updated} · ETH ref $${db.meta.eth_usd_ref}
> \`wl_value\` = utilidad como llave relativa al precio (editorial, 0–10).
> \`util\` = 1·GTD + 0.6·FCFS + 0.4·WL sobre mints registrados (evidencia dura).
> \`ce\` = util / floor_eth (coste-eficiencia; alto = infravalorada).

| # | Colección | Prio | Tier | Floor | Floor ETH | wl_value | GTD/FCFS/WL | util | ce | Tengo | Nota |
|--:|---|:--:|:--:|--:|--:|:--:|:--:|--:|--:|:--:|---|
`;

rows.forEach((c, i) => {
  out += `| ${i + 1} | ${c.name} | ${c.priority || ""} | ${c.tier} | ${fmtUsd(c.floor_usd)} | ${fmtEth(c.floor_eth)} | ${c.wl_value ?? "—"} | ${c.gtd || 0}/${c.fcfs || 0}/${c.wl || 0} | ${c.util.toFixed(1)} | ${c.ce == null ? "—" : Math.round(c.ce)} | ${c.owned ? "✅" : ""} | ${flag(c) || c.notes || ""} |\n`;
});

const owned = rows.filter((c) => c.owned);
out += `\n## Llaves que ya tenemos\n`;
out += owned.length
  ? owned.map((c) => `- **${c.name}** (${fmtUsd(c.floor_usd)})`).join("\n") + "\n"
  : "_Ninguna marcada \`owned:true\` en colecciones.json._\n";

out += `\n## Mejor valor ahora (🥇/🥈/💎 con wl_value ≥ 8, sin tener)\n`;
out += rows
  .filter((c) => !c.owned && (c.wl_value ?? 0) >= 8 && ["🥇", "🥈", "💎"].includes(c.priority))
  .map((c) => `- **${c.name}** — ${fmtUsd(c.floor_usd)} — wl_value ${c.wl_value}`)
  .join("\n") + "\n";

if (args.has("--write")) {
  writeFileSync(RANKING_PATH, out);
  console.error(`Escrito ${RANKING_PATH}`);
} else {
  process.stdout.write(out);
}
