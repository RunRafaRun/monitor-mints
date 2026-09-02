// Resuelve automáticamente el slug de OpenSea de cada colección y lo guarda en
// data/opensea-slugs.json.  NO hay que hacer nada a mano.
//
// Estrategia (en orden):
//   1. Lo ya conocido (opensea-slugs.json / campo slug en colecciones.json)
//   2. Por dirección de contrato: si la colección aparece en data/mints-cache.json
//      (feed de NFT Trencher), se pregunta a OpenSea por el contrato -> slug exacto.
//   3. Probando slugs candidatos (kebab, sin espacios, con sufijos) y quedándose
//      con el primero cuyo contrato esté en Robinhood Chain.
//
// Uso:  node resolve-slugs.mjs [--verbose]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, loadCollections, norm } from "./lib/data.mjs";

loadEnv(join(dirname(fileURLToPath(import.meta.url)), ".env"));
const KEY = process.env.OPENSEA_API_KEY;
if (!KEY) { console.error("Falta OPENSEA_API_KEY en scripts/.env"); process.exit(1); }
const H = { "x-api-key": KEY, accept: "application/json" };
const verbose = process.argv.includes("--verbose");
const log = (...a) => verbose && console.log(...a);

const db = loadCollections();
const SLUGS_PATH = join(ROOT, "data", "opensea-slugs.json");
const map = existsSync(SLUGS_PATH) ? JSON.parse(readFileSync(SLUGS_PATH, "utf8")) : { _comment: "Auto-generado por resolve-slugs.mjs" };
const rejected = new Set(map._rejected || []); // slugs copycat detectados por fetch-floors

// contratos conocidos desde el feed
const byContract = new Map();
const cachePath = join(ROOT, "data", "mints-cache.json");
if (existsSync(cachePath)) {
  for (const c of JSON.parse(readFileSync(cachePath, "utf8")).cards || []) {
    if (c.contract) byContract.set(norm(c.name), c.contract.toLowerCase());
    if (c.openseaSlug) map[c.name] ??= c.openseaSlug;
  }
}

async function chainOfSlug(slug) {
  try {
    const r = await fetch(`https://api.opensea.io/api/v2/collections/${slug}`, { headers: H });
    if (!r.ok) return null;
    const j = await r.json();
    return { chain: j?.contracts?.[0]?.chain || null, name: j?.name || null };
  } catch { return null; }
}

async function slugOfContract(addr) {
  try {
    const r = await fetch(`https://api.opensea.io/api/v2/chain/robinhood/contract/${addr}`, { headers: H });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.collection || null;
  } catch { return null; }
}

function candidates(name) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const flat = name.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return [...new Set([base, flat, base + "-rh", base + "-nft", "rh-" + base, base + "-1"])];
}

const unresolved = [];
let added = 0;

for (const c of db.collections) {
  if (map[c.name] || c.slug) { log("✓ ya:", c.name, map[c.name] || c.slug); continue; }

  // 2. por contrato
  const addr = byContract.get(norm(c.name));
  if (addr) {
    const s = await slugOfContract(addr);
    if (s) { map[c.name] = s; added++; console.log(`✔ ${c.name} → ${s}  (por contrato)`); await sleep(); continue; }
  }

  // 3. candidatos
  let hit = null;
  for (const s of candidates(c.name)) {
    if (rejected.has(s)) { log(`  – ${c.name}: "${s}" en _rejected, salto`); continue; }
    const info = await chainOfSlug(s);
    await sleep();
    if (info?.chain === "robinhood") { hit = s; break; }
    if (info) log(`  ~ ${c.name}: "${s}" existe pero chain=${info.chain}`);
  }
  if (hit) { map[c.name] = hit; added++; console.log(`✔ ${c.name} → ${hit}`); }
  else { unresolved.push(c.name); log(`✖ ${c.name}: sin slug`); }
}

writeFileSync(SLUGS_PATH, JSON.stringify(map, null, 2) + "\n");
console.log(`\n${added} nuevos · ${Object.keys(map).filter((k) => k[0] !== "_").length} slugs en total`);
if (unresolved.length) {
  console.log(`\n${unresolved.length} sin resolver (mantendrán su floor estimado):`);
  console.log("  " + unresolved.join(", "));
  console.log("  → si te importa alguna, pásame su URL de OpenSea y la añado.");
}

function sleep() { return new Promise((r) => setTimeout(r, 250)); }
function loadEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, "");
  }
}
