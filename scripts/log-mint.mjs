// Registra un mint observado y sube los contadores de las colecciones elegibles.
//
// Uso:
//   node log-mint.mjs mint.json          // lee un JSON con los datos del mint
//   echo '{...}' | node log-mint.mjs -   // lee JSON de stdin
//
// Formato del JSON:
// {
//   "fecha": "2026-09-03",           // opcional, por defecto hoy
//   "proyecto": "TerminalX",
//   "supply": 5555, "minted": 1243,
//   "fase": "GTD",                   // etiqueta libre
//   "tipo": "GTD",                   // GTD | FCFS | WL  (define la ponderación)
//   "precio": "FREE",
//   "colecciones_elegibles": ["StonkBrokers", "H00dle", "Broker Punks"],
//   "tengo_llave": "H00dle",
//   "floor_post_mint_usd": "",
//   "popularidad": "ALTO",
//   "fuente": "https://x.com/...",
//   "notas": ""
// }
import { readFileSync, appendFileSync, existsSync } from "node:fs";
import {
  loadCollections, saveCollections, findCollection,
  REGISTRO_PATH, csvField,
} from "./lib/data.mjs";

const src = process.argv[2];
if (!src) {
  console.error("Falta el JSON. Uso: node log-mint.mjs mint.json  |  ... | node log-mint.mjs -");
  process.exit(1);
}
const raw = src === "-" ? readFileSync(0, "utf8") : readFileSync(src, "utf8");
const m = JSON.parse(raw);

const fecha = m.fecha || new Date().toISOString().slice(0, 10);
const tipo = String(m.tipo || m.fase || "WL").toUpperCase();
const cols = Array.isArray(m.colecciones_elegibles)
  ? m.colecciones_elegibles
  : String(m.colecciones_elegibles || "").split(/[·,;|]/).map((s) => s.trim()).filter(Boolean);

// 1. Añadir fila al CSV.
const HEADER = "fecha,proyecto,supply,minted,fase,tipo,precio,colecciones_elegibles,tengo_llave,floor_post_mint_usd,popularidad,fuente,notas";
if (!existsSync(REGISTRO_PATH)) appendFileSync(REGISTRO_PATH, HEADER + "\n");
const line = [
  fecha, m.proyecto, m.supply, m.minted, m.fase, tipo, m.precio,
  cols.join(" · "), m.tengo_llave, m.floor_post_mint_usd, m.popularidad, m.fuente, m.notas,
].map(csvField).join(",");
appendFileSync(REGISTRO_PATH, line + "\n");
console.log(`✔ Registrado: ${m.proyecto} (${fecha}) — fase ${tipo}`);

// 2. Subir contadores.
const db = loadCollections();
const field = tipo.includes("GTD") ? "gtd" : tipo.includes("FCFS") ? "fcfs" : "wl";
const hits = [], misses = [];
for (const name of cols) {
  const c = findCollection(db, name);
  if (c) { c[field] = (c[field] || 0) + 1; hits.push(`${c.name} (${field}→${c[field]})`); }
  else misses.push(name);
}
db.meta.updated = fecha;
saveCollections(db);

if (hits.length) console.log("  +1 " + field + ": " + hits.join(", "));
if (misses.length) {
  console.log("  ⚠️ No están en colecciones.json (añádelas si son relevantes):");
  for (const n of misses) console.log("     - " + n);
}
console.log("\nRecalcula el ranking:  node rank.mjs --write");
