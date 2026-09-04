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
import { osCliBase, osCli, whoami, readAuth, refreshAuth, walletLabel } from "./lib/os-auth.mjs";

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
  // el token de sesión dura ~1 h: si caducó (o le queda poco) lo renovamos con el
  // refresh token, sin navegador. Si no hay refresh válido seguimos y avisamos.
  const preExp = readAuth()?.exp || null;
  const auth = refreshAuth();
  if (auth?.exp && preExp && auth.exp > preExp) log("Sesión OpenSea renovada");
  const me = whoami();
  if (!me) {
    die("No hay sesión de OpenSea. Ejecuta:  opensea login --scopes read:eligibility\n" +
        "Abre el navegador y firmas un mensaje — NO es una transacción.", 3);
  }
  log(`Sesión OpenSea: ${me.address}${me.exp ? ` · caduca ${new Date(me.exp).toLocaleString()}` : ""}`);
  if (auth?.exp && auth.exp < Date.now()) {
    log("⚠️ El token de OpenSea está caducado y no se pudo renovar. " +
        "Ejecuta:  opensea login --scopes read:eligibility  (o el botón «Reconectar»).");
  }
  const bearer = auth?.jwt || null;

  // 1) slugs a comprobar: los del radar (--slugs, pasados por serve.mjs) + el
  //    calendario de OpenSea (próximos + destacados + los que siguen minteando)
  const slugs = new Map();
  const extra = (process.argv.find((a) => a.startsWith("--slugs=")) || "").slice(8);
  for (const s of extra.split(",").map((x) => x.trim()).filter(Boolean)) {
    if (slugs.size >= MAX_DROPS) break;
    slugs.set(s, null);
  }
  let apiErr = 0;
  for (const type of ["upcoming", "featured", "recently_minted"]) {
    const { status, body } = await osGet(`/api/v2/drops?type=${type}&limit=100`);
    if (status !== 200 || !Array.isArray(body?.drops)) { log(`  drops ${type}: HTTP ${status}`); if (status === 401 || status === 429) apiErr++; continue; }
    for (const d of body.drops) {
      if (slugs.size >= MAX_DROPS) break;
      if (!CHAINS.includes(d.chain) || !d.collection_slug) continue;
      if (type === "recently_minted" && !d.is_minting && !d.next_stage) continue;
      if (!slugs.has(d.collection_slug)) slugs.set(d.collection_slug, d.chain);
    }
  }
  log(`${slugs.size} drops a comprobar`);
  if (!slugs.size) {
    if (apiErr) die("\n⚠️ La API de OpenSea no respondió (límite temporal). NO se toca data/eligibility-wallet.json.", 2);
    writeOut(me.address, {}, auth); return;
  }

  // caché de las fases de cada drop (labels/uuid no cambian) -> menos llamadas
  const metaPath = join(ROOT, "data", "contract-slugs.json").replace("contract-slugs", "drops-meta");
  let metaCache = {}; try { metaCache = JSON.parse(readFileSync(metaPath, "utf8")); } catch { /**/ }
  const META_TTL = 6 * 3600 * 1000;

  // 2) fases (API key) + elegibilidad (sesión) por drop
  const drops = {};
  let n = 0, hitList = 0, cliCalls = 0, metaWrote = false;
  for (const [slug, chain] of slugs) {
    n++;
    let metaStages = metaCache[slug] && (Date.now() - metaCache[slug]._at < META_TTL) ? metaCache[slug].stages : null;
    if (!metaStages) {
      const meta = await osGet(`/api/v2/drops/${slug}`);
      metaStages = Array.isArray(meta.body?.stages) ? meta.body.stages : [];
      metaCache[slug] = { _at: Date.now(), stages: metaStages };
      metaWrote = true;
    }

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
    // PUBLIC no cuenta: en la fase pública todo el mundo es elegible, no es una plaza
    const hits = stages.filter((s) => s.eligible === true && s.kind !== "PUBLIC").map((s) => s.kind);
    hitList += hits.length;
    if (hits.length) log(`  ✅ ${slug}: ${hits.join(", ")}`);
    if (n % 5 === 0) await new Promise((r) => setTimeout(r, 400));
  }
  if (metaWrote) { try { writeFileSync(metaPath, JSON.stringify(metaCache) + "\n"); } catch { /**/ } }

  writeOut(me.address, drops, auth);
  log(`\n✔ ${OUT}  ·  ${hitList} plaza(s) donde estás en la lista (GTD/FCFS/WL)`);
  if (asJson) process.stdout.write(JSON.stringify({ address: me.address, drops }, null, 2) + "\n");
}

main().catch((e) => die(`fetch-eligibility: ${e.message}`, 1));
