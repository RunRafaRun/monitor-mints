// Actualiza floor_eth / floor_usd en colecciones.json desde la API de OpenSea
// y guarda un histórico en data/floor-history.csv (para floor-alerts.mjs).
//
// Requiere:  scripts/.env con OPENSEA_API_KEY  (gratis: https://docs.opensea.io/reference/api-keys)
// Slugs de OpenSea: se resuelven en este orden
//   1. campo "slug" en colecciones.json
//   2. data/opensea-slugs.json   { "H00dle": "h00dle", ... }
//   3. data/mints-cache.json     (lo genera gen-radar.mjs, trae el slug del feed)
//   4. --set "Nombre=slug"       (lo guarda en colecciones.json y sale)
//
// Uso:
//   node fetch-floors.mjs
//   node fetch-floors.mjs --only "H00dle,Broker Punks"
//   node fetch-floors.mjs --set "H00dle=h00dle"
//   node fetch-floors.mjs --dry
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import {
  ROOT, loadCollections, saveCollections, findCollection, norm, csvField,
} from "./lib/data.mjs";

loadEnv(join(dirname(fileURLToPath(import.meta.url)), ".env"));
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const HISTORY = join(ROOT, "data", "floor-history.csv");

const db = loadCollections();

if (has("--set")) {
  const [name, slug] = String(val("--set")).split("=");
  const c = findCollection(db, name);
  if (!c) { console.error(`No encuentro "${name}"`); process.exit(1); }
  c.slug = slug; saveCollections(db);
  console.log(`✔ ${c.name}.slug = ${slug}`);
  process.exit(0);
}

const KEY = process.env.OPENSEA_API_KEY;
if (!KEY) {
  console.error("Falta OPENSEA_API_KEY en scripts/.env. Alta: https://docs.opensea.io/reference/api-keys");
  process.exit(1);
}

// --- resolver slugs ---
const slugMap = new Map();
const SLUGS_PATH = join(ROOT, "data", "opensea-slugs.json");
if (existsSync(SLUGS_PATH))
  for (const [k, v] of Object.entries(JSON.parse(readFileSync(SLUGS_PATH, "utf8"))))
    if (k[0] !== "_" && typeof v === "string") slugMap.set(norm(k), v);
const cache = join(ROOT, "data", "mints-cache.json");
if (existsSync(cache)) {
  for (const card of JSON.parse(readFileSync(cache, "utf8")).cards || []) {
    if (card.openseaSlug) slugMap.set(norm(card.name), card.openseaSlug);
  }
}
const slugOf = (c) => c.slug || slugMap.get(norm(c.name)) || (c.aliases || []).map((a) => slugMap.get(norm(a))).find(Boolean);

const only = val("--only")?.split(",").map((s) => norm(s.trim()));
const targets = db.collections.filter((c) => slugOf(c) && (!only || only.includes(norm(c.name))));
if (!targets.length) {
  console.error("Ninguna colección con slug resoluble. Usa --set, data/opensea-slugs.json, o corre gen-radar.mjs.");
  process.exit(1);
}

const ethUsd = await fetchEthUsd().catch(() => db.meta.eth_usd_ref);
console.log(`ETH/USD ≈ $${ethUsd}\n`);
const suspects = [];
if (!existsSync(HISTORY)) appendFileSync(HISTORY, "fecha,coleccion,slug,floor_eth,floor_usd\n");
const today = new Date().toISOString().slice(0, 10);

for (const c of targets) {
  const slug = slugOf(c);
  try {
    const r = await fetch(`https://api.opensea.io/api/v2/collections/${slug}/stats`, {
      headers: { "x-api-key": KEY, accept: "application/json" },
    });
    if (!r.ok) { console.log(`✖ ${c.name} (${slug}): HTTP ${r.status}`); continue; }
    const j = await r.json();
    const floorEth = j?.total?.floor_price ?? null;
    if (!floorEth || floorEth <= 0) {
      console.log(`… ${c.name}: sin listados / floor 0 — mantengo ${c.floor_eth ?? "—"} ETH`);
      continue;
    }
    const floorUsd = Math.round(floorEth * ethUsd * 100) / 100;
    const prev = c.floor_eth;
    const delta = prev ? ` (${(((floorEth - prev) / prev) * 100).toFixed(0)}%)` : "";
    // Salto > 3x respecto al valor previo -> slug probablemente equivocado (copycat).
    // No se sobrescribe: se mantiene el valor y se marca para verificar.
    const suspicious = prev && (floorEth > prev * 3 || floorEth < prev / 3);
    if (suspicious && !has("--force")) {
      console.log(`⚠️ ${c.name}: ${floorEth} ETH vs. ${prev} previo — slug "${slug}" dudoso, NO actualizo`);
      suspects.push({ name: c.name, slug, floorEth });
      // recordar el slug malo para que resolve-slugs no lo vuelva a añadir
      const sp = existsSync(SLUGS_PATH) ? JSON.parse(readFileSync(SLUGS_PATH, "utf8")) : {};
      sp._rejected = [...new Set([...(sp._rejected || []), slug])];
      if (sp[c.name] === slug) delete sp[c.name];
      writeFileSync(SLUGS_PATH, JSON.stringify(sp, null, 2) + "\n");
      continue;
    }
    console.log(`✔ ${c.name}: ${floorEth} ETH  $${floorUsd}${delta}`);
    appendFileSync(HISTORY, [today, c.name, slug, floorEth, floorUsd].map(csvField).join(",") + "\n");
    if (!has("--dry")) { c.floor_eth = floorEth; c.floor_usd = floorUsd; }
  } catch (e) {
    console.log(`✖ ${c.name}: ${e.message}`);
  }
  await new Promise((res) => setTimeout(res, 350));
}

if (!has("--dry")) {
  db.meta.updated = today;
  db.meta.eth_usd_ref = ethUsd;
  saveCollections(db);
  console.log("\n✔ colecciones.json + floor-history.csv actualizados.");
  console.log("  Siguiente:  node floor-alerts.mjs   y   node rank.mjs --write");
}
if (suspects.length) {
  console.log(`\n${suspects.length} slugs dudosos (posible copycat) — verifica en OpenSea y corrige data/opensea-slugs.json:`);
  for (const s of suspects) console.log(`  ${s.name}: "${s.slug}" → ${s.floorEth} ETH`);
  console.log("  (o borra esa línea del JSON para que quede el floor estimado)");
}

async function fetchEthUsd() {
  const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd");
  return (await r.json()).ethereum.usd;
}
function loadEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, "");
  }
}
