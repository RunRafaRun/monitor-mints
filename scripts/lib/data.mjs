// Utilidades compartidas: carga/guarda datos y calcula scores.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, "..", "..");
export const COLLECTIONS_PATH = join(ROOT, "data", "colecciones.json");
export const REGISTRO_PATH = join(ROOT, "data", "registro-mints.csv");
export const RANKING_PATH = join(ROOT, "data", "colecciones-wl-utility.md");

export function loadCollections() {
  return JSON.parse(readFileSync(COLLECTIONS_PATH, "utf8"));
}

export function saveCollections(db) {
  writeFileSync(COLLECTIONS_PATH, JSON.stringify(db, null, 2) + "\n");
}

// Normaliza un nombre para comparar (minúsculas, sin espacios ni signos).
export function norm(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Busca una colección por nombre o alias. Devuelve el objeto o null.
export function findCollection(db, name) {
  const n = norm(name);
  return (
    db.collections.find(
      (c) => norm(c.name) === n || (c.aliases || []).some((a) => norm(a) === n)
    ) || null
  );
}

// Utilidad demostrada a partir de los contadores de fases.
export function demonstratedUtility(c, { decay = false } = {}) {
  // Sin histórico por aparición: peso plano. Con --decay se aplicaría por fecha
  // (ver rank.mjs, que lee registro-mints.csv para el detalle temporal).
  const k = decay ? 1 : 1;
  return k * (1.0 * (c.gtd || 0) + 0.6 * (c.fcfs || 0) + 0.4 * (c.wl || 0));
}

export function costEfficiency(c) {
  const u = demonstratedUtility(c);
  if (!c.floor_eth || u === 0) return null;
  return u / c.floor_eth;
}

// Parser CSV mínimo (soporta comillas dobles y comas dentro de comillas).
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQ = false;
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (ch === "\r") { /* skip */ }
    else field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift();
  return rows
    .filter((r) => r.some((v) => v !== ""))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

export function csvField(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
