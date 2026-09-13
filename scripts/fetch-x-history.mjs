// Historial de cambios de nombre de usuario en X.
//
// Dos fuentes, combinadas:
//  1) memory.lol — archivo histórico (Twitter Stream Grab + Wayback Machine).
//     Gratis, sin clave, pero apenas cubre cuentas pequeñas/nuevas (la mayoría
//     de proyectos NFT recién creados no están indexados).
//  2) api.fxtwitter.com — lookup EN VIVO (no archivo), gratis, sin clave, y SÍ
//     funciona con cuentas diminutas. No tiene historial propio, así que aquí
//     hacemos tracking nosotros: guardamos id numérico (permanente) -> @handle
//     visto en cada pasada; si el mismo id aparece con un @handle nuevo,
//     es un cambio detectado EN DIRECTO entre dos actualizaciones nuestras.
//
// Lee los handles de X desde data/mints-cache.json (lo genera gen-radar.mjs) y
// guarda todo en data/x-history.json, con caché de 24h por handle para no
// martillear las APIs en cada --write del radar (los renames no cambian a minutos).
//
// Uso:
//   node fetch-x-history.mjs
//   node fetch-x-history.mjs --force     // ignora la caché de 24h
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib/data.mjs";

const argv = process.argv.slice(2);
const force = argv.includes("--force");
const TTL_MS = 24 * 3600e3;
const HIST_PATH = join(ROOT, "data", "x-history.json");
const CACHE_PATH = join(ROOT, "data", "mints-cache.json");

if (!existsSync(CACHE_PATH)) {
  console.error("Falta data/mints-cache.json — corre gen-radar.mjs --write antes.");
  process.exit(1);
}
const cards = JSON.parse(readFileSync(CACHE_PATH, "utf8")).cards || [];
const handleOf = (url) => {
  const m = /(?:x|twitter)\.com\/(?:#!\/)?@?([A-Za-z0-9_]{1,15})/i.exec(url || "");
  const h = m && m[1];
  if (!h || /^(i|home|search|intent|share|hashtag)$/i.test(h)) return null;
  return h;
};
const handles = [...new Set(cards.map((c) => handleOf(c.x)).filter(Boolean))];

const hist = existsSync(HIST_PATH) ? JSON.parse(readFileSync(HIST_PATH, "utf8")) : { handles: {}, byId: {} };
hist.handles ||= {};
hist.byId ||= {};

let checked = 0, hits = 0, errs = 0;
for (const handle of handles) {
  const key = handle.toLowerCase();
  const prev = hist.handles[key];
  if (!force && prev?.checkedAt && Date.now() - Date.parse(prev.checkedAt) < TTL_MS) continue;
  checked++;
  try {
    const entry = await lookup(handle);
    hist.handles[key] = { checkedAt: new Date().toISOString(), ...entry };
    if (entry.renames > 0) { hits++; console.log(`⚠ @${handle}: ${entry.renames} cambio(s), último ${entry.lastRenameAt || "?"}${entry.viaLive ? " (visto en directo)" : ""}`); }
  } catch (e) {
    errs++;
    hist.handles[key] = { checkedAt: new Date().toISOString(), error: String(e.message || e), renames: prev?.renames ?? null, lastRenameAt: prev?.lastRenameAt ?? null };
    console.log(`✖ @${handle}: ${e.message || e}`);
  }
  await new Promise((r) => setTimeout(r, 400));
}

writeFileSync(HIST_PATH, JSON.stringify(hist, null, 2) + "\n");
console.log(`\n${checked} handles consultados (${handles.length - checked} en caché) · ${hits} con renombres · ${errs} errores`);
console.log("Escrito data/x-history.json");

async function lookup(handle) {
  const live = await fetchLive(handle).catch(() => null);
  const archive = await lookupArchive(handle).catch(() => null);

  if (!live && archive) return archive; // sin id en vivo (cuenta suspendida/protegida) -> solo archivo
  if (!live) return { renames: 0, screenNames: {}, lastRenameAt: null };

  const id = String(live.id);
  const rec = hist.byId[id] || { names: {}, joinedAt: live.joined || null };
  let viaLive = false;
  if (!rec.names[live.screen_name]) {
    rec.names[live.screen_name] = new Date().toISOString();
    viaLive = Object.keys(rec.names).length > 1; // solo cuenta como "detectado" si ya conocíamos otro nombre
  }
  hist.byId[id] = rec;

  // combina con lo que diga el archivo (memory.lol), si aporta nombres que no teníamos
  for (const [name, firstSeen] of Object.entries(archive?.screenNames || {})) {
    if (!rec.names[name]) rec.names[name] = firstSeen;
  }

  const names = Object.keys(rec.names);
  const renames = Math.max(0, names.length - 1);
  const lastRenameAt = renames > 0
    ? Object.entries(rec.names).sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]))[0][1]
    : null;
  if (live.avatar) rec.avatar = live.avatar;
  return { id, renames, screenNames: rec.names, lastRenameAt, joinedAt: rec.joinedAt, followers: live.followers, avatar: rec.avatar || null, viaLive };
}

async function fetchLive(handle) {
  const r = await fetch(`https://api.fxtwitter.com/${encodeURIComponent(handle)}`, {
    headers: { accept: "application/json" },
  });
  if (!r.ok) throw new Error(`fxtwitter HTTP ${r.status}`);
  const j = await r.json();
  const u = j?.user;
  if (!u || !u.id) throw new Error("fxtwitter: sin usuario");
  return { id: u.id, screen_name: u.screen_name, joined: u.joined ? new Date(u.joined).toISOString() : null, followers: u.followers ?? null, avatar: u.avatar_url || null };
}

async function lookupArchive(handle) {
  const r = await fetch(`https://api.memory.lol/v1/tw/${encodeURIComponent(handle)}`, {
    headers: { accept: "application/json" },
  });
  if (r.status === 404) return { renames: 0, screenNames: {}, lastRenameAt: null };
  if (!r.ok) throw new Error(`memory.lol HTTP ${r.status}`);
  const j = await r.json();
  const acc = (j.accounts || [])[0];
  if (!acc) return { renames: 0, screenNames: {}, lastRenameAt: null };
  const names = acc.screen_names || {};
  const out = {};
  for (const [name, range] of Object.entries(names)) out[name] = range[0]; // primera fecha observada
  return { screenNames: out };
}
