// Escanea tus wallets (data/wallets.json) y cruza lo que tienes con el ranking de llaves.
//
// Uso:
//   node scan-wallets.mjs            informe: qué llaves tienes y en qué wallet
//   node scan-wallets.mjs --write    además: rellena owned + owned_wallets en colecciones.json
//                                    y escribe data/holdings.json (lo lee el dashboard)
//   node scan-wallets.mjs --json     vuelca el escaneo crudo (JSON)
//
// Solo lee direcciones públicas. Necesita OPENSEA_API_KEY en scripts/.env.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCollections, saveCollections, findCollection, norm } from "./lib/data.mjs";
import { loadWallets, scanAllWallets, slugToName, HOLDINGS_PATH } from "./lib/wallets.mjs";

// carga scripts/.env -> OPENSEA_API_KEY
(() => {
  const p = join(dirname(fileURLToPath(import.meta.url)), ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, "");
  }
})();

const argv = process.argv.slice(2);
const write = argv.includes("--write");
const asJson = argv.includes("--json");

const wallets = loadWallets();
if (!wallets.length) {
  console.error("No hay wallets en data/wallets.json. Añade { \"label\": \"...\", \"address\": \"0x...\" }.");
  process.exit(1);
}
const key = process.env.OPENSEA_API_KEY;
if (!key) { console.error("Falta OPENSEA_API_KEY en scripts/.env (ver SETUP.md)."); process.exit(1); }

console.error(`Escaneando ${wallets.length} wallet(s) en Robinhood Chain…`);
const scan = await scanAllWallets(wallets, key);

for (const w of scan.wallets) {
  if (w.error) console.error(`  ⚠️ ${w.label} (${w.address}): ${w.error}`);
  else console.error(`  ✔ ${w.label}: ${scan.perWallet[w.label].reduce((n, h) => n + h.count, 0)} NFTs en ${scan.perWallet[w.label].length} colecciones`);
}

if (asJson) { console.log(JSON.stringify(scan, null, 2)); process.exit(0); }

// --- cruce con el ranking de llaves ---
const db = loadCollections();
const s2n = slugToName();

// held: nombre de colección catalogada -> { wallets:[{label,count}], slug }
const heldKeys = new Map();
const heldUnknown = []; // colecciones que tienes pero no están en colecciones.json

for (const [id, info] of Object.entries(scan.bySlug)) {
  const name = info.slug ? s2n.get(info.slug) : null;
  const coll = name ? findCollection(db, name) : null;
  if (coll) {
    heldKeys.set(coll.name, { wallets: info.holders, slug: info.slug, contract: info.contract });
  } else {
    heldUnknown.push({ slug: info.slug, contract: info.contract, total: info.total, holders: info.holders });
  }
}

// informe
const line = (c, w) => `  ${c.owned || heldKeys.has(c.name) ? "✅" : "  "} ${c.name.padEnd(24)} ${(c.tier || "").padEnd(3)} wl:${c.wl_value ?? "—"}   ${w}`;
console.log(`\n🔑 LLAVES QUE TIENES (${heldKeys.size})`);
if (!heldKeys.size) console.log("  (ninguna de las catalogadas)");
for (const [name, h] of [...heldKeys].sort()) {
  const c = findCollection(db, name) || { name };
  const w = h.wallets.map((x) => `${x.label}×${x.count}`).join(", ");
  console.log(line(c, w));
}

const ranked = db.collections
  .filter((c) => (c.wl_value ?? 0) >= 6 || c.core_key)
  .filter((c) => !heldKeys.has(c.name));
console.log(`\n❌ LLAVES TOP QUE NO TIENES (wl_value ≥ 6 o core_key) (${ranked.length})`);
for (const c of ranked.sort((a, b) => (b.wl_value ?? 0) - (a.wl_value ?? 0)).slice(0, 20)) {
  console.log(`     ${c.name.padEnd(24)} ${(c.tier || "").padEnd(3)} wl:${c.wl_value ?? "—"}  floor:${c.floor_eth ?? "?"}Ξ`);
}

if (heldUnknown.length) {
  console.log(`\n👀 TIENES ESTAS COLECCIONES Y NO ESTÁN CATALOGADAS (${heldUnknown.length}) — revisa si alguna es llave:`);
  for (const u of heldUnknown.sort((a, b) => b.total - a.total)) {
    console.log(`     ${(u.slug || u.contract).padEnd(36)} ×${u.total}  (${u.holders.map((h) => h.label).join(", ")})`);
  }
}

if (write) {
  // 1) colecciones.json: owned + owned_wallets desde el escaneo
  let touched = 0;
  for (const c of db.collections) {
    const h = heldKeys.get(c.name);
    if (h) {
      c.owned = true;
      c.owned_wallets = h.wallets.map((x) => x.label);
      touched++;
    } else if (c.owned_wallets) {
      // antes venía de un escaneo y ya no lo tienes -> limpiar
      delete c.owned_wallets;
      c.owned = false;
    }
  }
  saveCollections(db);

  // 2) holdings.json (crudo + cruce) para el dashboard
  const holdings = {
    updated: scan.updated,
    wallets: scan.wallets,
    keys: [...heldKeys].map(([name, h]) => ({ name, wallets: h.wallets, slug: h.slug })),
    unknown: heldUnknown,
    perWallet: scan.perWallet,
  };
  writeFileSync(HOLDINGS_PATH, JSON.stringify(holdings, null, 2) + "\n");

  console.log(`\n✔ colecciones.json actualizado (${touched} llaves marcadas) y data/holdings.json escrito.`);
  console.log("  Regenera:  node gen-dashboard.mjs   (o pulsa Actualizar si usas serve.mjs)");
} else {
  console.log("\n(usa  --write  para volcar esto a colecciones.json y al dashboard)");
}
