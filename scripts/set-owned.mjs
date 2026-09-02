// Marca qué colecciones tienes (owned:true) en data/colecciones.json.
//
//   node set-owned.mjs "H00dle" "Broker Punks"      -> esas SON tu lista completa (el resto -> false)
//   node set-owned.mjs --add "Gremlin Cartel"       -> añade sin tocar las demás
//   node set-owned.mjs --remove "PitBoys"           -> quita
//   node set-owned.mjs --list                       -> muestra las que tienes
import { loadCollections, saveCollections, findCollection } from "./lib/data.mjs";

const argv = process.argv.slice(2);
const mode = argv[0] === "--add" ? "add" : argv[0] === "--remove" ? "remove" : argv[0] === "--list" ? "list" : "replace";
const names = (mode === "replace" ? argv : argv.slice(1)).filter((a) => !a.startsWith("--"));

const db = loadCollections();

if (mode === "list") {
  const owned = db.collections.filter((c) => c.owned).map((c) => c.name);
  console.log(owned.length ? owned.map((n) => "  ✅ " + n).join("\n") : "  (ninguna marcada)");
  process.exit(0);
}

const miss = [];
const resolve = (n) => { const c = findCollection(db, n); if (!c) miss.push(n); return c; };

if (mode === "replace") {
  const set = new Set(names.map((n) => resolve(n)).filter(Boolean));
  for (const c of db.collections) c.owned = set.has(c);
} else {
  for (const n of names) { const c = resolve(n); if (c) c.owned = mode === "add"; }
}

saveCollections(db);
const owned = db.collections.filter((c) => c.owned).map((c) => c.name);
console.log(`✔ Tienes ${owned.length}: ${owned.join(", ") || "—"}`);
if (miss.length) console.log(`⚠️ No encontradas en colecciones.json: ${miss.join(", ")}`);
console.log("\nRegenera:  node gen-dashboard.mjs   (o refresca si usas  node serve.mjs)");
