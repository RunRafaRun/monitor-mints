// Genera el ROBINHOOD MINT RADAR desde el feed de NFT Trencher.
//
// Uso:
//   node gen-radar.mjs                 // imprime el radar (markdown)
//   node gen-radar.mjs --write         // guarda data/radar.md + data/mints-cache.json
//   node gen-radar.mjs --hours 48      // ventana de "SOON" (por defecto 72 h)
//   node gen-radar.mjs --min-hype 20   // oculta mints con hype < 20 y sin X
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchFeed, popularityVerdict } from "./lib/trencher.mjs";
import { ROOT, loadCollections, findCollection } from "./lib/data.mjs";

const argv = process.argv.slice(2);
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const soonHours = Number(opt("--hours", 72));
const minHype = Number(opt("--min-hype", 0));
const write = argv.includes("--write");

const db = loadCollections();
const ownedNames = new Set(db.collections.filter((c) => c.owned).map((c) => c.name));
const cards = await fetchFeed("robinhood");

const now = Date.now();
const soonCut = now + soonHours * 3600e3;
const fmt = (ms) => (ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") + "Z" : "?");
const hoursTo = (ms) => (ms ? ((ms - now) / 3600e3).toFixed(1) + "h" : "?");

// Fases relevantes = cualquier gate GTD/FCFS/WL/HOLDER que no haya terminado.
const relevant = (g) => ["GTD", "FCFS", "WL", "HOLDER"].includes(g.kind) && (g.endMs ?? 0) > now;

const live = [], soon = [];
for (const c of cards) {
  if ((c.hype ?? 0) < minHype && !c.x) continue;
  const hot = c.gates.some((g) => relevant(g) && (g.startMs ?? 0) <= now);
  const upcoming = c.gates.some((g) => relevant(g) && (g.startMs ?? 0) > now && (g.startMs ?? 0) <= soonCut);
  if (c.isLive || hot) live.push(c);
  else if (upcoming || (c.startMs && c.startMs > now && c.startMs <= soonCut)) soon.push(c);
}
live.sort((a, b) => (b.hype ?? 0) - (a.hype ?? 0) || (b.xFollowers ?? 0) - (a.xFollowers ?? 0));
const sortSoon = argv.includes("--by-hype")
  ? (a, b) => (b.hype ?? 0) - (a.hype ?? 0)
  : (a, b) => (a.startMs ?? 9e15) - (b.startMs ?? 9e15);
soon.sort(sortSoon);

const keyLine = (c) => {
  // El feed no trae colecciones elegibles -> marcar para investigación manual.
  const owned = [...ownedNames].length
    ? `\n⭐ Revisa si alguna llave tuya aplica: ${[...ownedNames].join(" · ")}`
    : "";
  return `⚠️ ELIGIBILITY COLLECTIONS NOT YET FOUND — investigar en X (${c.x || "sin X"}) / web / OpenSea${owned}`;
};

const gatesBlock = (c) =>
  c.gates
    .filter((g) => g.kind !== "OTHER")
    .map((g) => `  ${g.kind.padEnd(7)} ${g.price || g.priceText || "?"}  ·  ${g.when || fmt(g.startMs)}  ·  ${g.state}`)
    .join("\n");

const card = (c) => `🚨 ${c.name}${c.isLive ? " — 🟢 MINTING NOW" : ""}
Supply: ${c.minted ?? "?"} / ${c.supply ?? "?"}${c.mintRate ? `  ·  ritmo ${c.mintRate}` : ""}
Hype: ${c.hype ?? "?"}/100 (${c.tier || "?"})  ·  X: ${c.xFollowers ?? "?"} followers / ${c.xPosts ?? "?"} posts / cuenta ${c.xAgeDays >= 0 ? c.xAgeDays + "d" : "N/A"}  ·  team: ${c.team || "?"}
Popularidad: ${popularityVerdict(c)}
Fases:
${gatesBlock(c) || "  (sin fases detalladas)"}
${keyLine(c)}
🔗 ${[c.x, c.site, c.opensea].filter(Boolean).join("  ·  ") || "sin enlaces"}
`;

let out = `# 🚨 ROBINHOOD MINT RADAR — ${new Date().toISOString().slice(0, 16).replace("T", " ")}Z

Fuente: NFT Trencher feed · ventana SOON: ${soonHours} h · ${cards.length} mints en el feed

## 🟢 MINTING NOW / fase WL-GTD-FCFS abierta (${live.length})

| Proyecto | Supply | Hype | X followers | Popularidad | Fase abierta |
|---|---|--:|--:|:--:|---|
`;
for (const c of live) {
  const g = c.gates.find((x) => ["GTD", "FCFS", "WL", "HOLDER"].includes(x.kind) && (x.startMs ?? 0) <= now && (x.endMs ?? 0) > now);
  out += `| ${c.name} | ${c.minted ?? "?"}/${c.supply ?? "?"} | ${c.hype ?? "?"} | ${c.xFollowers ?? "?"} | ${popularityVerdict(c)} | ${g ? g.kind + " " + (g.price || "") : (c.isLive ? "PUBLIC" : "?")} |\n`;
}

out += `\n## 🔵 UPCOMING — próximas ${soonHours} h (${soon.length})\n\n`;
out += `| Proyecto | Empieza | En | Fases WL/GTD/FCFS | Hype | X fol | Popularidad |\n|---|---|--:|---|--:|--:|:--:|\n`;
for (const c of soon) {
  const gs = c.gates.filter((g) => ["GTD", "FCFS", "WL", "HOLDER"].includes(g.kind) && (g.endMs ?? 0) > now);
  const first = gs[0]?.startMs ?? c.startMs;
  out += `| ${c.name} | ${fmt(first)} | ${hoursTo(first)} | ${gs.map((g) => g.kind + " " + (g.price || "")).join(", ") || "?"} | ${c.hype ?? "?"} | ${c.xFollowers ?? "?"} | ${popularityVerdict(c)} |\n`;
}

const worth = (c) => (c.hype ?? 0) > 0 || c.x;
out += `\n---\n\n## Fichas detalladas (solo mints con X o hype > 0)\n\n### 🟢 Ahora\n\n`;
out += live.filter(worth).map(card).join("\n") || "_nada relevante_\n";
out += `\n### 🔵 Próximas\n\n`;
out += soon.filter(worth).map(card).join("\n") || "_nada relevante_\n";

out += `\n---\n_Recuerda: el feed no incluye los nombres de las colecciones elegibles para\nGTD/FCFS/WL. Investígalos a mano y regístralos con \`node log-mint.mjs\`._\n`;

if (write) {
  writeFileSync(join(ROOT, "data", "radar.md"), out);
  writeFileSync(
    join(ROOT, "data", "mints-cache.json"),
    JSON.stringify({ updated: new Date().toISOString(), cards }, null, 2) + "\n"
  );
  console.error("Escrito data/radar.md y data/mints-cache.json");
} else {
  process.stdout.write(out);
}
