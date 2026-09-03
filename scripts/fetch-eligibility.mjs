// Comprueba si TU wallet está en la lista (GTD / FCFS / WL / presale) de cada
// drop de OpenSea (SeaDrop) en RobinHood / Ethereum / Ink, y lo guarda en
// data/eligibility-wallet.json para que el dashboard lo pinte en el radar.
//
// Uso:
//   node fetch-eligibility.mjs            comprueba y escribe data/eligibility-wallet.json
//   node fetch-eligibility.mjs --json     además vuelca el resultado por stdout
//
// Requiere una sesión de OpenSea (firma un mensaje, NO es una transacción):
//   npx -y @opensea/cli@2 login --scopes read:eligibility
//   (o el botón "Conectar OpenSea" del dashboard en modo servidor)
// El token queda en ~/.opensea/auth.json, en tu máquina. `opensea auth refresh`
// cuando caduque. NUNCA se pide ni se guarda la clave privada.
//
// Códigos de salida:  0 ok · 2 sin CLI · 3 sin sesión

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT } from "./lib/data.mjs";
import { osCliBase, osCli, whoami, readAuth, walletLabel } from "./lib/os-auth.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(ROOT, "data", "eligibility-wallet.json");
const CHAINS = ["robinhood", "ethereum", "ink"];
const MAX_DROPS = 60;                 // tope total (radar + calendario)
const uuNorm = (u) => String(u || "").replace(/-/g, "").toLowerCase();
const asJson = process.argv.includes("--json");
const log = (...a) => console.error(...a);
const die = (msg, code) => { console.error(msg); process.exit(code); };

// scripts/.env -> OPENSEA_API_KEY
(() => {
  const p = join(HERE, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, "");
  }
})();
const API_KEY = process.env.OPENSEA_API_KEY || "";

const STAGE_KIND = (type, label) => {
  const t = String(type || "").toUpperCase();
  const u = String(label || "").toUpperCase();
  if (t === "PUBLIC_SALE" || /PUBLIC/.test(u)) return "PUBLIC";
  if (/FCFS/.test(u)) return "FCFS";
  if (/\bGTD\b|GUARANTEED/.test(u)) return "GTD";
  if (/TEAM|TREASURY|PARTNER|VAULT|RESERVE|PRE-?MINT/.test(u)) return "TEAM";
  if (/HOLDER/.test(u)) return "HOLDER";
  return "WL";
};

const headers = (bearer) => ({
  accept: "application/json",
  ...(API_KEY ? { "x-api-key": API_KEY } : {}),
  ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
});
async function osGet(path, bearer) {
  const r = await fetch(`https://api.opensea.io${path}`, { headers: headers(bearer) });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}
function eligibilityViaCli(slug) {
  const out = osCli(["api", "request", "GET", `/api/v2/drops/${slug}/eligibility`, "--format", "json"]);
  if (!out) return null;
  try { return JSON.parse(out); } catch { return null; }
}

function writeOut(address, drops, auth) {
  writeFileSync(OUT, JSON.stringify({
    updated: new Date().toISOString(),
    wallet: { address, label: walletLabel(ROOT, address) },
    expiresAt: auth?.exp || null,
    drops,
  }, null, 2) + "\n");
}

async function main() {
  if (!osCliBase()) {
    die("Falta el CLI de OpenSea. Una vez:  npm i -g @opensea/cli\n" +
        "(o deja que npx lo baje). Luego:  opensea login --scopes read:eligibility", 2);
  }
  const me = whoami();
  if (!me) {
    die("No hay sesión de OpenSea. Ejecuta:  opensea login --scopes read:eligibility\n" +
        "Abre el navegador y firmas un mensaje — NO es una transacción.", 3);
  }
  log(`Sesión OpenSea: ${me.address}${me.exp ? ` · caduca ${new Date(me.exp).toLocaleString()}` : ""}`);
  const auth = readAuth();
  const bearer = auth?.jwt || null;

  // 1) slugs a comprobar: los del radar (--slugs, pasados por serve.mjs) + el
  //    calendario de OpenSea (próximos + destacados + los que siguen minteando)
  const slugs = new Map();
  const extra = (process.argv.find((a) => a.startsWith("--slugs=")) || "").slice(8);
  for (const s of extra.split(",").map((x) => x.trim()).filter(Boolean)) {
    if (slugs.size >= MAX_DROPS) break;
    slugs.set(s, null);
  }
  for (const type of ["upcoming", "featured", "recently_minted"]) {
    const { status, body } = await osGet(`/api/v2/drops?type=${type}&limit=100`);
    if (status !== 200 || !Array.isArray(body?.drops)) { log(`  drops ${type}: HTTP ${status}`); continue; }
    for (const d of body.drops) {
      if (slugs.size >= MAX_DROPS) break;
      if (!CHAINS.includes(d.chain) || !d.collection_slug) continue;
      if (type === "recently_minted" && !d.is_minting && !d.next_stage) continue;
      if (!slugs.has(d.collection_slug)) slugs.set(d.collection_slug, d.chain);
    }
  }
  log(`${slugs.size} drops a comprobar`);
  if (!slugs.size) { writeOut(me.address, {}, auth); return; }

  // 2) fases (API key) + elegibilidad (sesión) por drop
  const drops = {};
  let n = 0, hitStages = 0, cliCalls = 0;
  for (const [slug, chain] of slugs) {
    n++;
    const meta = await osGet(`/api/v2/drops/${slug}`);
    const metaStages = Array.isArray(meta.body?.stages) ? meta.body.stages : [];

    let elig = null;
    if (bearer) {
      const r = await osGet(`/api/v2/drops/${slug}/eligibility`, bearer);
      if (r.status === 200) elig = r.body;
      else if (n === 1) log(`  /eligibility HTTP ${r.status} con el token del auth.json`);
    }
    if (!elig && cliCalls < 6) { cliCalls++; elig = eligibilityViaCli(slug); }
    // los uuid vienen con guiones en /eligibility y sin ellos en /drops -> normalizar
    const byUuid = new Map((elig?.stages || []).map((s) => [uuNorm(s.stage_uuid), s]));

    const stages = metaStages.map((s) => {
      const e = byUuid.get(uuNorm(s.uuid));
      return {
        uuid: s.uuid,
        label: s.label || null,
        type: s.stage_type || null,
        kind: STAGE_KIND(s.stage_type, s.label),
        wlCount: s.allowlist_wallet_count ?? null,
        eligible: e ? !!e.is_eligible : null,
        priceWei: (e?.price ?? s.price) ?? null,
        max: (e?.max_total_mintable_by_wallet ?? s.max_per_wallet) ?? null,
        start: s.start_time || null,
        end: s.end_time || null,
      };
    });
    drops[slug] = { chain, stages };
    const hits = stages.filter((s) => s.eligible === true).map((s) => s.kind);
    hitStages += hits.length;
    if (hits.length) log(`  ✅ ${slug}: ${hits.join(", ")}`);
    if (n % 5 === 0) await new Promise((r) => setTimeout(r, 400));
  }

  writeOut(me.address, drops, auth);
  log(`\n✔ ${OUT}  ·  ${hitStages} fase(s) donde estás en la lista`);
  if (asJson) process.stdout.write(JSON.stringify({ address: me.address, drops }, null, 2) + "\n");
}

main().catch((e) => die(`fetch-eligibility: ${e.message}`, 1));
