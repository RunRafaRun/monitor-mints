// Calcula la cartera / P&L de las direcciones apuntadas en
// data/community-wallets.json y escribe una por fichero en
// public-data/portfolios/<addr>.json  (lo que luego el dashboard estático lee).
//
//   node community-portfolios.mjs           recalcula las que estén "viejas"
//   node community-portfolios.mjs --force    recalcula todas
//   FORCE=1 node community-portfolios.mjs    idem
//
// Cada dirección se procesa lanzando fetch-trades.mjs --address=… --out=…, así
// que comparte toda su lógica (Blockscout + floors OpenSea, guard de no pisar
// datos buenos si la API falla). Un fallo puntual NO rompe el lote.

import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT } from "./lib/data.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIST = join(ROOT, "data", "community-wallets.json");
const OUTDIR = join(ROOT, "public-data", "portfolios");
const ADDR_RE = /^0x[0-9a-f]{40}$/;
const MAX_AGE = 4 * 3600 * 1000;            // recalcular si el JSON tiene > 4 h
const GAP_MS = 3000;                         // respiro entre carteras (no saturar APIs)
const force = process.argv.includes("--force") || process.env.FORCE === "1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let raw = [];
try { raw = JSON.parse(readFileSync(LIST, "utf8")); } catch (e) {
  console.error(`data/community-wallets.json ilegible: ${e.message}`); process.exit(0);
}
const list = [...new Set(
  (Array.isArray(raw) ? raw : raw.wallets || [])
    .map((x) => String(typeof x === "string" ? x : x?.address || "").trim().toLowerCase())
    .filter((a) => ADDR_RE.test(a)),
)];

if (!list.length) { console.error("Sin direcciones válidas — nada que hacer."); process.exit(0); }
mkdirSync(OUTDIR, { recursive: true });
console.error(`${list.length} cartera(s) de la comunidad${force ? " · --force" : ""}`);

let ok = 0, skip = 0, fail = 0;
for (const addr of list) {
  const out = join(OUTDIR, `${addr}.json`);
  if (!force && existsSync(out)) {
    try {
      const age = Date.now() - Date.parse(JSON.parse(readFileSync(out, "utf8")).updated);
      if (age >= 0 && age < MAX_AGE) {
        console.error(`  ⏭  ${addr}  (fresco, ${(age / 3.6e6).toFixed(1)} h)`);
        skip++; continue;
      }
    } catch { /* JSON roto -> recalcular */ }
  }
  console.error(`\n▶ ${addr}`);
  const r = spawnSync(process.execPath,
    [join(HERE, "fetch-trades.mjs"), `--address=${addr}`, `--out=${out}`],
    { stdio: "inherit" });
  if (r.status === 0) ok++;
  else { fail++; console.error(`  ⚠️ salió con ${r.status} — se conserva el JSON anterior si lo había`); }
  await sleep(GAP_MS);
}

console.error(`\n✔ ${ok} calculadas · ${skip} frescas · ${fail} con error`);
process.exit(0);   // un error puntual no debe tumbar el workflow
