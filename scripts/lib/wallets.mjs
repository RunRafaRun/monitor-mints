// Escaneo de wallets: qué NFTs hay en cada dirección de Robinhood Chain.
//
// Config: data/wallets.json (fuera de git)
//   { "wallets": [ { "label": "Principal", "address": "0x…" } ] }
//   Solo direcciones PÚBLICAS. Nunca claves privadas ni frases semilla.
//
// Fuente: OpenSea API v2, endpoint  chain/robinhood/account/{address}/nfts
// (usa OPENSEA_API_KEY de scripts/.env, la misma que el resto de scripts).

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./data.mjs";

export const WALLETS_PATH = join(ROOT, "data", "wallets.json");
export const HOLDINGS_PATH = join(ROOT, "data", "holdings.json");
const CHAIN = "robinhood";
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

// Lee data/wallets.json -> [{ label, address }]  (address en minúsculas, sin duplicados).
export function loadWallets() {
  if (!existsSync(WALLETS_PATH)) return [];
  let raw;
  try { raw = JSON.parse(readFileSync(WALLETS_PATH, "utf8")); }
  catch (e) { throw new Error(`data/wallets.json no es JSON válido: ${e.message}`); }
  const list = Array.isArray(raw) ? raw : raw.wallets || [];
  const seen = new Set();
  const out = [];
  for (const w of list) {
    const address = String(w.address || w.addr || "").trim().toLowerCase();
    if (!ADDR_RE.test(address)) { console.error(`wallets: dirección ignorada (formato): ${w.address}`); continue; }
    if (seen.has(address)) continue;
    seen.add(address);
    out.push({ label: String(w.label || `wallet-${out.length + 1}`).trim(), address });
  }
  return out;
}

// Todos los NFTs de una dirección, agrupados por colección.
// -> [{ slug, contract, count, sample }]
export async function scanWallet(address, key, { pages = 20, pause = 120 } = {}) {
  if (!key) throw new Error("Falta OPENSEA_API_KEY");
  const H = { headers: { "x-api-key": key, accept: "application/json" } };
  const byColl = new Map();
  let cursor = null;
  for (let i = 0; i < pages; i++) {
    const u = new URL(`https://api.opensea.io/api/v2/chain/${CHAIN}/account/${address}/nfts`);
    u.searchParams.set("limit", "200");
    if (cursor) u.searchParams.set("next", cursor);
    const r = await fetch(u, H);
    if (!r.ok) throw new Error(`OpenSea ${r.status} para ${address}`);
    const j = await r.json();
    for (const n of j.nfts || []) {
      const slug = n.collection || null;
      const kk = slug || (n.contract || "").toLowerCase();
      if (!kk) continue;
      const rec = byColl.get(kk) || { slug, contract: (n.contract || "").toLowerCase() || null, count: 0, sample: null };
      rec.count++;
      if (!rec.sample && n.name) rec.sample = n.name;
      byColl.set(kk, rec);
    }
    cursor = j.next || null;
    if (!cursor) break;
    if (pause) await new Promise((res) => setTimeout(res, pause));
  }
  return [...byColl.values()].sort((a, b) => b.count - a.count);
}

// Escanea todas las wallets y consolida.
// -> { updated, wallets:[{label,address,error?}], perWallet:{label:[...]},
//      bySlug:{ slug:{ contract, total, holders:[{label,count}] } } }
export async function scanAllWallets(wallets, key, opts) {
  const perWallet = {};
  const bySlug = {};
  const meta = [];
  for (const w of wallets) {
    let holdings = [];
    let error = null;
    try { holdings = await scanWallet(w.address, key, opts); }
    catch (e) { error = e.message; }
    meta.push({ label: w.label, address: w.address, ...(error ? { error } : {}) });
    perWallet[w.label] = holdings;
    for (const h of holdings) {
      const id = h.slug || h.contract;
      if (!id) continue;
      const s = (bySlug[id] ||= { slug: h.slug, contract: h.contract, total: 0, holders: [] });
      s.total += h.count;
      s.holders.push({ label: w.label, count: h.count });
      if (!s.contract && h.contract) s.contract = h.contract;
    }
  }
  return { updated: new Date().toISOString(), wallets: meta, perWallet, bySlug };
}

// Mapa inverso slug -> nombre de colección, desde data/opensea-slugs.json.
export function slugToName() {
  const p = join(ROOT, "data", "opensea-slugs.json");
  const map = new Map();
  if (!existsSync(p)) return map;
  const j = JSON.parse(readFileSync(p, "utf8"));
  for (const [name, slug] of Object.entries(j)) {
    if (name.startsWith("_") || typeof slug !== "string") continue;
    map.set(slug, name);
  }
  return map;
}
