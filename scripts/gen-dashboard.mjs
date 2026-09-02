// Genera un dashboard HTML autocontenido para abrir en el navegador.
//
// Uso:  node gen-dashboard.mjs            -> data/dashboard.html  (ábrelo con doble clic)
//       node gen-dashboard.mjs --open     -> además lo abre en el navegador (Windows)
//
// Junta: radar de mints (feed NFT Trencher) + ranking de llaves + prioridad de compra
// + alertas de floor. Todo embebido: funciona sin conexión una vez generado.
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { fetchFeed, popularityVerdict } from "./lib/trencher.mjs";
import { fetchDailyMints } from "./lib/wlmt.mjs";
import {
  ROOT, loadCollections, demonstratedUtility, costEfficiency,
  parseCsv, findCollection, norm,
} from "./lib/data.mjs";

// carga scripts/.env para OPENSEA_API_KEY
(() => {
  const p = join(dirname(fileURLToPath(import.meta.url)), ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, "");
  }
})();

const FLOOR_CACHE = join(ROOT, "data", "mint-floors.json");
const FLOOR_TTL = 20 * 60 * 1000; // 20 min

// Floor actual (ETH) + minteados EN VIVO de cada slug de OpenSea, con caché en disco.
// El feed de NFT Trencher trae el "minted" a veces desfasado; OpenSea va al día.
async function openseaForSlugs(items, ethUsd) {
  // items: [{slug, contract}].  Robinhood Chain: el floor puede venir en ETH o en
  // stablecoin (USDG/USDC) -> hay que mirar floor_price_symbol y normalizar a USD+ETH.
  const key = process.env.OPENSEA_API_KEY;
  const H = { headers: { "x-api-key": key, accept: "application/json" } };
  let cache = {};
  try { cache = JSON.parse(readFileSync(FLOOR_CACHE, "utf8")); } catch {}
  const now = Date.now();
  const bySlug = new Map();
  for (const it of items) if (it.slug) bySlug.set(it.slug, (it.contract || "").toLowerCase());
  const stale = [...bySlug.keys()].filter((s) => !cache[s] || now - cache[s].at > FLOOR_TTL);
  if (key && stale.length) {
    for (const slug of stale.slice(0, 60)) {
      const rec = { usd: null, eth: null, sym: null, minted: null, sales: 0, at: now, samples: cache[slug]?.samples || [], bad: false,
        owners: null, fee: null, vol24: null, volTotal: null, listed: null };
      try {
        const [s, c] = await Promise.all([
          fetch(`https://api.opensea.io/api/v2/collections/${slug}/stats`, H),
          fetch(`https://api.opensea.io/api/v2/collections/${slug}`, H),
        ]);
        let fp = null, sym = null, curUsd = null;
        if (s.ok) {
          const st = await s.json();
          const tt = st?.total || {};
          fp = tt.floor_price ?? null; sym = tt.floor_price_symbol || null;
          rec.sales = tt.sales ?? 0;
          rec.owners = tt.num_owners ?? null;
          rec.volTotal = tt.volume ?? null;
          const d1 = (st?.intervals || []).find((x) => x.interval === "one_day");
          rec.vol24 = d1?.volume ?? null;
        }
        if (c.ok) {
          const j = await c.json();
          rec.minted = j?.total_supply ?? j?.unique_item_count ?? null;
          curUsd = Number(j?.pricing_currencies?.listing_currency?.usd_price) || null;
          // creator fee: suma de las fees declaradas (RH Chain OpenSea = 0% marketplace)
          const fees = Array.isArray(j?.fees) ? j.fees : [];
          if (fees.length) rec.fee = Math.round(fees.reduce((a, f) => a + (Number(f.fee) || 0), 0) * 100) / 100;
          const want = bySlug.get(slug);
          const got = (j?.contracts || []).map((x) => (x.address || "").toLowerCase());
          if (want && got.length && !got.includes(want)) rec.bad = true;
        }
        if (fp != null) {
          rec.sym = sym;
          if (sym === "ETH" || sym === "WETH") { rec.eth = fp; rec.usd = fp * ethUsd; }
          else { const u = fp * (curUsd || 1); rec.usd = u; rec.eth = ethUsd ? u / ethUsd : null; } // stablecoin
        }
      } catch {}
      if (rec.bad) { rec.usd = rec.eth = rec.minted = rec.owners = rec.fee = rec.vol24 = rec.volTotal = null; }
      if (rec.minted != null) rec.samples = [...rec.samples, { m: rec.minted, at: now }].slice(-6);
      cache[slug] = rec;
      await new Promise((r) => setTimeout(r, 90));
    }
    try { writeFileSync(FLOOR_CACHE, JSON.stringify(cache) + "\n"); } catch {}
  }
  return cache;
}

// Construye el objeto de datos del dashboard (lo usan gen-dashboard.mjs y serve.mjs).
// pub:true  -> versión PÚBLICA para compartir: sin datos personales
// (nada de owned / wallets / holdings). Cada visitante marca "lo que tiene"
// en el localStorage de su propio navegador.
export async function buildData({ pub = false } = {}) {
  const db = loadCollections();
  const now = Date.now();
  const soonCut = now + 72 * 3600e3;
  const KEYPHASE = ["GTD", "FCFS", "WL", "HOLDER"];
  const relevant = (g) => KEYPHASE.includes(g.kind) && (g.endMs ?? 0) > now;

  let cards = [];
  try { cards = await fetchFeed("robinhood"); }
  catch (e) { console.error("No pude bajar el feed de NFT Trencher:", e.message); }

  // dedup por nombre: la tarjeta con más señal
  const seen = new Map();
  for (const c of cards) {
    const k = c.name.toLowerCase();
    const score = (x) => (x.hype ?? 0) + (x.x ? 5 : 0) + x.gates.length;
    if (!seen.has(k) || score(c) > score(seen.get(k))) seen.set(k, c);
  }

  // elegibilidad manual: data/eligibility.json  { "TerminalX": ["H00dle","Broker Punks"] }
  const eligPath = join(ROOT, "data", "eligibility.json");
  const elig = existsSync(eligPath) ? JSON.parse(readFileSync(eligPath, "utf8")) : {};
  const ownedSet = new Map(db.collections.map((c) => [norm(c.name), !!c.owned]));
  const ownedAlias = (name) => {
    const c = findCollection(db, name);
    return c ? !!c.owned : ownedSet.get(norm(name)) || false;
  };

  // en qué wallet está cada llave: data/holdings.json (lo escribe scan-wallets.mjs)
  const holdPath = join(ROOT, "data", "holdings.json");
  const holdings = existsSync(holdPath) ? JSON.parse(readFileSync(holdPath, "utf8")) : null;
  const walletsByColl = new Map();
  for (const k of holdings?.keys || []) walletsByColl.set(norm(k.name), k.wallets.map((w) => w.label));
  const walletsFor = (name) => {
    const c = findCollection(db, name);
    return walletsByColl.get(norm(c ? c.name : name)) || [];
  };
  const need1 = (n) => ({ name: n, owned: ownedAlias(n), wallets: walletsFor(n) });

  const mints = [...seen.values()]
    .map((c) => {
      const liveGate = c.gates.find((g) => g.state === "live" || ((g.startMs ?? 0) <= now && (g.endMs ?? 1e18) > now));
      const openKey = c.gates.find((g) => relevant(g) && (g.startMs ?? 0) <= now && (g.endMs ?? 0) > now);
      const nextGate = c.gates.filter((g) => relevant(g) && (g.startMs ?? 0) > now).sort((a, b) => a.startMs - b.startMs)[0];
      let status = "later";
      if (c.isLive || liveGate) status = "now";
      else if (nextGate && nextGate.startMs <= soonCut) status = "soon";
      else if (c.startMs && c.startMs > now && c.startMs <= soonCut) status = "soon";
      const openGate = openKey || liveGate;
      const need = (elig[c.name] || []).map(need1);
      return {
        name: c.name, status,
        minted: c.minted, supply: c.supply, mintRate: c.mintRate,
        hype: c.hype ?? 0, tier: c.tier, team: c.team,
        xFollowers: c.xFollowers, xPosts: c.xPosts, xAgeDays: c.xAgeDays, socials: c.socials,
        pop: popularityVerdict(c),
        priceEth: c.priceEth ?? null, free: !!c.free,
        when: (openGate || nextGate)?.startMs ?? c.startMs ?? null,
        phases: c.gates.filter((g) => g.kind !== "OTHER").map((g) => ({ k: g.kind, p: g.price || g.priceText || "?", s: g.state, a: g.startMs, e: g.endMs, lim: g.perWallet })),
        need, haveKey: need.some((n) => n.owned),
        x: c.x, site: c.site, opensea: c.opensea, slug: c.openseaSlug || null,
        contract: (c.contract || "").toLowerCase() || null,
        srcs: 1,
      };
    })
    .filter((m) => m.status !== "later");

  // --- fuente secundaria: cruce y complemento ---
  const extra = await fetchDailyMints().catch(() => []);
  if (extra.length) {
    const byName = new Map(mints.map((m) => [norm(m.name), m]));
    const bySlug = new Map(mints.filter((m) => m.slug).map((m) => [m.slug, m]));
    const KEYK = ["GTD", "FCFS", "WL", "HOLDER", "TEAM"];
    const phaseWhen = (ph) => {
      const live = ph.find((p) => p.startMs && p.endMs && p.startMs <= now && p.endMs > now);
      const next = ph.filter((p) => p.startMs && p.startMs > now).sort((a, b) => a.startMs - b.startMs)[0];
      return { live, next };
    };
    for (const e of extra) {
      const hit = (e.slug && bySlug.get(e.slug)) || byName.get(norm(e.name));
      if (hit) {
        hit.srcs = 2;
        if (!hit.supply && e.supply) hit.supply = e.supply;
        if (!hit.contract && e.contract) hit.contract = e.contract;
        if (!hit.slug && e.slug) hit.slug = e.slug;
        // completar precio USD / allocation por tipo de fase
        for (const ep of e.phases) {
          const tp = hit.phases.find((p) => p.k === ep.kind);
          if (tp) { if (ep.priceUsd != null && tp.usd == null) tp.usd = ep.priceUsd; if (ep.allocation != null && tp.lim == null) tp.lim = ep.allocation; }
        }
        // colecciones elegibles si esta fuente las trae
        const elg = [...new Set(e.phases.flatMap((p) => p.eligible || []))];
        if (elg.length && !hit.need.length) {
          hit.need = elg.map(need1);
          hit.haveKey = hit.need.some((n) => n.owned);
        }
      } else {
        const { live, next } = phaseWhen(e.phases);
        // solo añadimos si aporta una fase de llave (GTD/FCFS/WL/HOLDER/TEAM) reciente,
        // no un "public stage" de hace días que técnicamente sigue abierto
        const keyLive = e.phases.some((p) => KEYK.includes(p.kind) && p.startMs <= now && (p.endMs ?? 0) > now);
        const keySoon = e.phases.some((p) => KEYK.includes(p.kind) && p.startMs > now && p.startMs <= soonCut);
        const freshPublic = live && live.kind === "PUBLIC" && live.startMs > now - 36 * 3600e3;
        let status = "later";
        if (keyLive || freshPublic) status = "now";
        else if (keySoon) status = "soon";
        if (status === "later") continue;
        const need = [...new Set(e.phases.flatMap((p) => p.eligible || []))].map(need1);
        mints.push({
          name: e.name, status,
          minted: null, supply: e.supply, mintRate: null,
          hype: 0, tier: null, team: null,
          xFollowers: null, xPosts: null, xAgeDays: -1, socials: 0,
          pop: "🔴 sin X",
          priceEth: null, free: e.phases.some((p) => p.free),
          when: (live || next)?.startMs ?? e.mintDate ?? null,
          phases: e.phases.filter((p) => p.kind !== "OTHER").map((p) => ({
            k: p.kind, p: p.free ? "FREE" : p.priceEth != null ? p.priceEth + " ETH" : "?",
            s: p.startMs && p.startMs <= now && (p.endMs ?? 1e18) > now ? "live" : p.endMs && p.endMs < now ? "ended" : "upcoming",
            a: p.startMs, e: p.endMs, lim: p.allocation, usd: p.priceUsd,
          })),
          need, haveKey: need.some((n) => n.owned),
          x: e.x, site: e.site, opensea: null, slug: e.slug, contract: e.contract,
          srcs: 1, onlyExtra: true,
        });
      }
    }
  }

  mints.sort((a, b) => (a.status === b.status ? (b.hype - a.hype) : a.status === "now" ? -1 : 1));

  // floor + minteados en vivo desde OpenSea (el feed trae el minted desfasado)
  const ETHUSD = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd")
    .then((r) => r.json()).then((j) => j.ethereum.usd).catch(() => db.meta.eth_usd_ref || 2400);
  const os = await openseaForSlugs(mints.map((m) => ({ slug: m.slug, contract: m.contract })), ETHUSD);
  for (const m of mints) {
    const o = m.slug ? os[m.slug] : null;
    // floor solo fiable si hay mercado real (>=3 ventas)
    const real = o && o.sales >= 3;
    m.floorUsd = real ? o.usd : (o && o.usd === 0 ? 0 : null);
    m.floorEth = real ? o.eth : (o && o.eth === 0 ? 0 : null);
    m.floorSym = o?.sym || null;
    m.floorThin = !!(o && o.usd && o.sales < 3);
    // minted solo sube: nos quedamos con el mayor de (feed, OpenSea)
    if (o && o.minted != null) { m.mintedLive = o.minted; m.minted = Math.max(m.minted || 0, o.minted); }
    // mercado / concentración / fee del creador (de las mismas llamadas a OpenSea)
    m.owners = o?.owners ?? null;
    m.fee = o?.fee ?? null;
    m.vol24 = o?.vol24 ?? null;
    m.volTotal = o?.volTotal ?? null;
    const base = m.mintedLive || m.minted || 0;
    m.ownersPct = m.owners != null && base > 0 ? m.owners / base : null;
    // NFTs "extra" concentrados fuera de las wallets únicas (proxy de acumulación)
    m.whaleHint = m.owners != null && base > 0 ? Math.max(0, base - m.owners) : null;
    // ritmo propio: minteados por 15 min a partir del histórico de muestras
    const sm = o?.samples || [];
    if (sm.length >= 2) {
      const last = sm[sm.length - 1];
      const ref = [...sm].reverse().find((x) => last.at - x.at >= 8 * 60000) || sm[0];
      const mins = (last.at - ref.at) / 60000;
      if (mins >= 5) m.rate15 = Math.max(0, Math.round(((last.m - ref.m) / mins) * 15));
    }
  }

  const ranking = db.collections
    .map((c) => ({
      name: c.name, priority: c.priority || "", tier: c.tier,
      floorEth: c.floor_eth, floorUsd: c.floor_usd, wlValue: c.wl_value,
      gtd: c.gtd || 0, fcfs: c.fcfs || 0, wl: c.wl || 0,
      util: demonstratedUtility(c), ce: costEfficiency(c), owned: !!c.owned,
      wallets: walletsByColl.get(norm(c.name)) || [],
      notes: c.notes || "",
    }))
    .sort((a, b) => (b.wlValue ?? -1) - (a.wlValue ?? -1) || b.util - a.util || (a.floorEth ?? 9e9) - (b.floorEth ?? 9e9));

  let alerts = [];
  const HIST = join(ROOT, "data", "floor-history.csv");
  if (existsSync(HIST)) {
    const rows = parseCsv(readFileSync(HIST, "utf8"))
      .map((r) => ({ ...r, floor_eth: Number(r.floor_eth), t: Date.parse(r.fecha) }))
      .filter((r) => r.floor_eth > 0).sort((a, b) => a.t - b.t);
    const byCol = new Map();
    for (const r of rows) { if (!byCol.has(r.coleccion)) byCol.set(r.coleccion, []); byCol.get(r.coleccion).push(r); }
    const cut = now - 7 * 86400e3;
    for (const [name, h] of byCol) {
      const latest = h[h.length - 1];
      const ref = [...h].reverse().find((r) => r.t <= cut) || h[0];
      if (ref === latest) continue;
      const change = ((latest.floor_eth - ref.floor_eth) / ref.floor_eth) * 100;
      if (Math.abs(change) >= 15) {
        const c = findCollection(db, name);
        alerts.push({ name, priority: c?.priority || "", change, from: ref.floor_eth, to: latest.floor_eth });
      }
    }
    alerts.sort((a, b) => a.change - b.change);
  }

  const holdSummary = holdings
    ? {
        updated: holdings.updated,
        wallets: (holdings.wallets || []).map((w) => w.label),
        keys: (holdings.keys || []).map((k) => k.name),
        errors: (holdings.wallets || []).filter((w) => w.error).map((w) => `${w.label}: ${w.error}`),
      }
    : null;

  const out = { updated: new Date().toISOString(), ethUsd: ETHUSD, mints, ranking, alerts, holdings: holdSummary, public: !!pub };
  return pub ? stripPersonal(out) : out;
}

// Quita del payload todo lo que revele la cartera del usuario.
function stripPersonal(d) {
  for (const c of d.ranking) { c.owned = false; c.wallets = []; }
  for (const m of d.mints) {
    m.haveKey = false;
    for (const n of m.need || []) { n.owned = false; n.wallets = []; }
  }
  d.holdings = null;
  return d;
}

// CLI: genera data/dashboard.html
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || process.argv[1].endsWith("gen-dashboard.mjs")) {
  const pub = process.argv.includes("--public") || process.env.PUBLIC === "1";
  const data = await buildData({ pub });
  const outPath = join(ROOT, "data", "dashboard.html");
  writeFileSync(outPath, html(data));
  console.log("✔ " + outPath + (pub ? "  (modo público, sin datos personales)" : ""));
  if (process.argv.includes("--open")) {
    try { execSync(`start "" "${outPath}"`, { shell: "cmd.exe" }); } catch {}
  }
}

export function html(data, { served = false } = {}) {
  const J = JSON.stringify(data).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${data.public ? '<meta http-equiv="refresh" content="900">' : ""}
<title>Monitor MINTS — Robinhood Chain</title>
<style>
:root{color-scheme:light dark;--bg:#0f1115;--card:#191d24;--fg:#e7e9ee;--mut:#9aa4b2;--line:#2a2f3a;
--now:#2ecc71;--soon:#4aa3ff;--warn:#ff6b6b;--gold:#f1c40f;--accent:#7aa2ff}
@media(prefers-color-scheme:light){:root{--bg:#f6f7f9;--card:#fff;--fg:#1a1d24;--mut:#5b6572;--line:#e3e6eb}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);
font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header{padding:14px 14px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:5}
.hrow{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}
h1{margin:0;font-size:17px}h2{margin:20px 14px 8px;font-size:14px;color:var(--mut);text-transform:uppercase;letter-spacing:.05em}
.sub{color:var(--mut);font-size:12px;margin-top:4px}
.wrap{max-width:1900px;margin:0 auto;padding-bottom:60px}
.tabs{display:flex;gap:6px;margin-top:12px;flex-wrap:wrap}
.tabs button,.lang button,.chk{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:999px;
padding:5px 12px;cursor:pointer;font-size:13px}
.tabs button.on{background:var(--accent);color:#fff;border-color:var(--accent)}
.lang{display:flex;gap:0;border:1px solid var(--line);border-radius:999px;overflow:hidden}
.lang button{border:0;border-radius:0;padding:5px 10px}.lang button.on{background:var(--accent);color:#fff}
.chk{display:inline-flex;gap:6px;align-items:center;margin:0 14px 4px}
table{width:calc(100% - 28px);margin:0 14px;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:7px 9px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--mut);font-weight:600;cursor:pointer;white-space:nowrap;user-select:none}
tr:hover td{background:color-mix(in srgb,var(--card) 60%,transparent)}
.pill{display:inline-block;font-size:11px;color:var(--mut);border:1px solid var(--line);border-radius:5px;padding:0 5px;margin:1px 2px 1px 0}
.ph-GTD{color:var(--now);border-color:color-mix(in srgb,var(--now) 45%,var(--line))}
.ph-FCFS{color:var(--soon);border-color:color-mix(in srgb,var(--soon) 45%,var(--line))}
.ph-WL,.ph-HOLDER{color:var(--gold);border-color:color-mix(in srgb,var(--gold) 45%,var(--line))}
.pill.live{font-weight:700;border-width:1.5px;box-shadow:0 0 0 1px currentColor inset;background:color-mix(in srgb,currentColor 12%,transparent)}
.pill.ended{opacity:.4;text-decoration:line-through}
.phwrap{display:inline-block;white-space:nowrap;margin:1px 4px 1px 0}
.phwhen{font-size:10px;color:var(--mut)}
.phlim{margin-left:4px;padding-left:4px;border-left:1px solid currentColor;opacity:.8;font-size:11px}
.num{text-align:right;font-variant-numeric:tabular-nums}
.eth{color:var(--mut);font-size:11px}
.scroll{overflow-x:auto}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.owned{color:var(--now);font-weight:700}
.drop{color:var(--warn);font-weight:700}.rise{color:var(--now)}
.muted{color:var(--mut)}
.note{margin:8px 14px;color:var(--mut);font-size:12px}
.xstat{display:inline-flex;align-items:center;gap:3px;margin-right:8px;font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap}
.xstat svg{width:13px;height:13px;fill:currentColor;opacity:.75}
.xnew{color:var(--warn)}
.badge{display:inline-block;padding:1px 6px;border-radius:6px;font-size:11px;font-weight:700}
.b-now{background:rgba(46,204,113,.16);color:var(--now)}.b-soon{background:rgba(74,163,255,.16);color:var(--soon)}
.pop-hi{color:var(--now)}.pop-mid{color:var(--gold)}.pop-lo{color:var(--mut)}
.v2{color:var(--now);font-size:11px;font-weight:700;letter-spacing:-1px}
.have-key{color:var(--now);font-weight:700;font-size:11px;margin-bottom:2px}
.pill.k-own{color:var(--now);border-color:color-mix(in srgb,var(--now) 55%,var(--line))}
.wchip{display:inline-block;font-size:10px;padding:0 4px;border-radius:4px;background:color-mix(in srgb,var(--accent) 22%,transparent);color:var(--fg);margin-left:3px;vertical-align:middle}
tr.row-have td{background:color-mix(in srgb,var(--now) 9%,transparent)}
.ownchk{width:15px;height:15px;cursor:pointer}
#toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);background:var(--card);color:var(--fg);
border:1px solid var(--line);border-radius:10px;padding:10px 14px;font-size:12px;white-space:pre-wrap;max-width:90vw;
box-shadow:0 8px 30px rgba(0,0,0,.35);opacity:0;transition:opacity .3s;z-index:20}
#helpModal{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:flex-start;justify-content:center;
padding:40px 16px;z-index:50;overflow:auto}
#helpModal[hidden]{display:none}
.hm-box{background:var(--card);border:1px solid var(--line);border-radius:14px;max-width:760px;width:100%;
padding:22px 26px;position:relative;box-shadow:0 20px 60px rgba(0,0,0,.5)}
.hm-x{position:absolute;top:8px;right:10px;background:transparent;border:0;color:var(--mut);font-size:17px;cursor:pointer}
.hm-box h3{margin:.1em 0 .5em;font-size:16px}
.hm-box h4{margin:1.1em 0 .35em;font-size:13px;color:var(--accent);text-transform:uppercase;letter-spacing:.04em}
.hm-box p{font-size:12.5px;line-height:1.6}
.hm-box ul{margin:.2em 0 .4em;padding-left:1.1em}
.hm-box li{font-size:12.5px;line-height:1.65;margin-bottom:.35em}
.hm-box code{background:color-mix(in srgb,var(--fg) 13%,transparent);padding:0 4px;border-radius:4px;font-size:11.5px}
.bell{background:transparent;border:0;cursor:pointer;font-size:13px;opacity:.45;padding:0 4px;line-height:1;vertical-align:middle}
.bell:hover{opacity:.9}.bell.on{opacity:1}

/* ---- móvil: cada fila pasa a ficha ---- */
@media (max-width:860px){
  header{padding:10px}
  h1{font-size:15px}
  h2{margin:16px 10px 6px}
  .note{margin:8px 10px}
  .wrap{padding-bottom:40px}
  .scroll{overflow:visible}
  table{width:auto;margin:0 10px;font-size:13px}
  thead{display:none}
  table,tbody,tr,td{display:block}
  tr{background:var(--card);border:1px solid var(--line);border-radius:12px;margin:0 0 10px;padding:8px 12px}
  tr:hover td{background:transparent}
  td{border:0;padding:4px 0;text-align:left!important}
  td::before{content:attr(data-label);display:block;color:var(--mut);font-weight:600;font-size:10px;
    text-transform:uppercase;letter-spacing:.03em;margin-bottom:1px}
  td[data-label=""]::before,td:not([data-label])::before{display:none}
  td:first-child{font-size:15px;border-bottom:1px solid var(--line);padding-bottom:6px;margin-bottom:4px}
  tr.row-have{outline:2px solid color-mix(in srgb,var(--now) 45%,transparent)}
  .hm-box{padding:18px 16px}
}
</style></head><body>
<div class="wrap">
<header>
  <div class="hrow">
    <h1>🚨 Monitor MINTS — Robinhood Chain</h1>
    <div style="display:flex;gap:8px;align-items:center">
      ${served ? '<button id="refreshBtn" class="chk" style="border-radius:8px"><span data-k="refresh"></span></button>' : ""}
      <button id="helpBtn" class="chk" style="border-radius:8px;font-weight:700" title="?">?</button>
      <div class="lang" id="lang"><button data-l="es">ES</button><button data-l="en">EN</button></div>
    </div>
  </div>
  <div class="sub" id="upd"></div>
  <div class="tabs" id="tabs">
    <button data-t="radar" class="on">🔥 <span data-k="tab_radar"></span></button>
    <button data-t="keys">🔑 <span data-k="tab_keys"></span></button>
    <button data-t="buy">🛒 <span data-k="tab_buy"></span></button>
    <button data-t="floors">📉 <span data-k="tab_floors"></span></button>
  </div>
</header>

<section data-p="radar">
  <p class="note" id="legend"></p>
  <h2 data-k="h_now"></h2>
  <div class="scroll"><table id="tNow"></table></div>
  <h2 data-k="h_soon"></h2>
  <label class="chk"><input type="checkbox" id="hideLow"> <span data-k="hide_low"></span></label>
  <div class="scroll"><table id="tSoon"></table></div>
  <p class="note" data-k="note_elig"></p>
</section>

<section data-p="keys" hidden>
  <h2 data-k="h_keys"></h2>
  <p class="note" data-k="note_keys"></p>
  <div class="scroll"><table id="tKeys"></table></div>
</section>

<section data-p="buy" hidden>
  <h2 data-k="h_buy"></h2>
  <div class="scroll"><table id="tBuy"></table></div>
</section>

<section data-p="floors" hidden>
  <h2 data-k="h_floors"></h2>
  <div class="scroll"><table id="tFloors"></table></div>
  <p class="note" data-k="note_floors"></p>
</section>
</div>

<div id="helpModal" hidden>
  <div class="hm-box">
    <button id="helpClose" class="hm-x" title="✕">✕</button>
    <div id="helpBody"></div>
  </div>
</div>

<script>
let D = ${J};
const SERVED = ${served ? "true" : "false"};
const ETHUSD = D.ethUsd || 2400;

// overrides de "owned" cuando se abre como fichero (sin servidor)
const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g,'');
let ownLocal = {};
try { ownLocal = JSON.parse(localStorage.getItem('mints_owned')||'{}'); } catch(e){}
function isOwned(name){
  const n = norm(name);
  if(n in ownLocal) return ownLocal[n];
  const c = D.ranking.find(x=>norm(x.name)===n);
  return c ? !!c.owned : false;
}
async function setOwned(name, val){
  const n = norm(name);
  if(SERVED){
    try{
      await fetch('api/owned',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name,owned:val})});
      await reload();
      toast(t('saved'));
    }catch(e){ toast('⚠️ '+e.message); }
  }else{
    ownLocal[n]=val; localStorage.setItem('mints_owned',JSON.stringify(ownLocal));
    const c = D.ranking.find(x=>norm(x.name)===n); if(c) c.owned=val;
    render();
    if(D.public){ toast(t('save_local'), 4000); }
    else {
      const list = D.ranking.filter(x=>isOwned(x.name)).map(x=>'"'+x.name+'"').join(' ');
      toast(t('save_hint')+'\\n  node set-owned.mjs '+list, 9000);
    }
  }
}
function toast(msg,ms=4000){
  let el=document.getElementById('toast');
  if(!el){el=document.createElement('div');el.id='toast';document.body.appendChild(el);}
  el.textContent=msg; el.style.opacity='1';
  clearTimeout(el._t); el._t=setTimeout(()=>el.style.opacity='0',ms);
}
async function reload(full){
  if(!SERVED) return;
  if(full){ toast(t('refreshing')); await fetch('api/refresh',{cache:'no-store'}); }
  const r=await fetch('api/data',{cache:'no-store'}); D=await r.json(); render();
  if(full) toast(t('updated_ok'));
}

const STR = {
 es:{tab_radar:'Radar',tab_keys:'Llaves',tab_buy:'Comprar',tab_floors:'Floors',
  h_now:'Minteando ahora / fase abierta',h_soon:'Próximas 72 h',
  hide_low:'ocultar sin señal (sin X y hype 0)',
  note_elig:'El feed no trae los nombres de las colecciones elegibles para GTD/FCFS/WL: investígalos en X / web / OpenSea y regístralos con  node log-mint.mjs.',
  h_keys:'Ranking de llaves — utilidad WL/GTD/FCFS frente al precio',
  note_keys:'wl_value = criterio editorial 0–10 (relación llave/precio). util = 1·GTD + 0.6·FCFS + 0.4·WL sobre mints registrados. ce = util/floor (alto = infravalorada).',
  h_buy:'Prioridad de compra',
  h_floors:'Alertas de floor (±15 % / 7 días)',
  note_floors:'Se llena según  node fetch-floors.mjs  va acumulando histórico.',
  c_project:'Proyecto',c_supply:'Minteado',c_hype:'Hype',c_pop:'Popularidad',c_x:'Actividad X',
  c_phases:'Fases',c_when:'Cuándo',c_price:'Precio public',c_keys:'Llaves',c_have:'Tengo',
  c_coll:'Colección',c_prio:'Prio',c_tier:'Tier',c_floor:'Floor',c_wl:'wl_value',c_ev:'GTD/FCFS/WL',c_note:'Nota',
  c_before:'Floor antes',c_after:'Floor ahora',
  now:'en curso',nothing_now:'nada minteando ahora',nothing_soon:'nada en 72 h',no_hist:'sin histórico todavía',
  pop_hi:'ALTA',pop_mid:'MEDIA',pop_lo:'BAJA',pop_nox:'sin X',
  x_fol:'seguidores',x_posts:'posts',x_age:'antigüedad de la cuenta',days:'d',new_acct:'cuenta nueva',
  need_unknown:'elegibilidad sin investigar',have_key:'TIENES LLAVE',in_wallet:'wallet donde tienes esta llave',
  cartera:'llaves en tus wallets',cartera_none:'ninguna llave detectada en tus wallets',
  save_hint:'Marcado en este navegador. Para guardarlo en el fichero ejecuta:',
  save_local:'Guardado en este navegador (solo tú lo ves).',
  sys_update:'se actualiza solo cada 15 min',
  refresh:'Actualizar',saved:'Guardado en colecciones.json',refreshing:'Actualizando…',updated_ok:'Datos actualizados ✓',
  rate_tip:'Estimación /15 min a partir del ritmo de 2 h de NFT Trencher (÷8). Se vuelve exacto (sin ~) cuando el monitor lleva ≥15 min en marcha con serve.mjs.',
  rate_tip15:'Ritmo real: minteados en los últimos ~15 min (calculado por el monitor con datos de OpenSea)',
  no_market:'sin mercado',thin_market:'mercado mínimo',closes:'cierra',
  limit_tip:'NFTs máximos por wallet en esta fase',two_src:'confirmado en 2 fuentes',
  owners_tip:'Wallets únicas que poseen algún NFT, y qué % son del total minteado. Cerca del 100% = muy repartido. Bajo = pocas wallets acumulan muchos (🐳 si <45%).',
  fee_tip:'Creator fee / royalty: % que se lleva el proyecto en cada reventa',
  fee_lbl:'💸 royalty',
  vol_tip:'Volumen de ventas en las últimas 24 h (moneda del floor)',
  alert_tip:'Avisarme ~10 min antes del próximo cambio de fase (deja la pestaña abierta)',
  alert_set:'🔔 Alerta activada. Te avisaré ~10 min antes. Deja esta pestaña abierta.',
  alert_set_toast:'🔔 Alerta activada (aviso en la propia página; las notificaciones del navegador están bloqueadas).',
  alert_off:'🔕 Alerta quitada',
  alert_body:'cambio de fase en ~{m} min',
  legend:'Fases: <b class="ph-GTD">GTD</b> plaza garantizada · <b class="ph-FCFS">FCFS</b> por orden de llegada · <b class="ph-WL">WL/Holder</b> lista genérica · <b>TEAM/PUBLIC</b> equipo / abierto a todos.  <b>●</b> = abierta ahora · <s>tachada</s> = terminada · <b>×N</b> = NFTs por wallet',
  help:'<h3>Cómo leer Monitor MINTS</h3>'+
   '<p>Seguimiento en vivo de los mints de Robinhood Chain. Se actualiza solo cada 15 min. Lo que marques se guarda solo en tu navegador.</p>'+
   '<h4>Una fila del Radar</h4><ul>'+
   '<li><b>Proyecto</b> — nombre + enlaces (X / web / OpenSea). <code>live</code> = minteando ahora, <code>SOON</code> = en menos de 72 h, <b>✓✓</b> = confirmado en 2 fuentes.</li>'+
   '<li><b>Minteado</b> — <code>373 / 4.4K</code> = minteados / supply total. <b>⚡ +N/15m</b> = ritmo en los últimos 15 min (<code>~</code> = estimación). <b>👤 294 (79%)</b> = wallets únicas con algún NFT y su % sobre lo minteado: verde ≥70% repartido, ámbar 45–70%, rojo + 🐳 por debajo de 45% = pocas wallets acumulan.</li>'+
   '<li><b>Hype / Popularidad / Actividad X</b> — hype del feed, lectura ALTA/MEDIA/BAJA de la cuenta de X, y los números en crudo: seguidores · posts · antigüedad. Antigüedad marcada = cuenta con menos de 30 días.</li>'+
   '<li><b>Fases</b> — una pastilla por fase con su precio. <b class="ph-GTD">GTD</b> plaza garantizada · <b class="ph-FCFS">FCFS</b> por orden de llegada · <b class="ph-WL">WL/Holder</b> lista genérica · <b>TEAM/PUBLIC</b> equipo / abierto a todos. <b>●</b> abierta ahora · <s>tachada</s> terminada · <code>×N</code> máximo de NFTs por wallet.</li>'+
   '<li><b>Llaves</b> — qué colecciones te dan acceso a ese mint. <b>⭐ TIENES LLAVE</b> si posees una; <i>elegibilidad sin investigar</i> = aún sin averiguar (las listas se anuncian en X/Discord).</li>'+
   '<li><b>Precio public</b> — precio de mint público ($ + ETH). <b>💸 royalty X%</b> = comisión del creador en cada reventa.</li>'+
   '<li><b>Floor</b> — floor del mercado secundario. <code>· 2.8×</code> = floor frente al precio de mint (verde sube / rojo baja); <code>FREE→$X</code> en mints gratis; <i>sin mercado / mercado mínimo</i> cuando hay pocas ventas.</li>'+
   '<li><b>Cuándo</b> — cuenta atrás + hora exacta (UTC y tu hora local). El icono <b>🔕/🔔</b> activa un aviso ~10 min antes del siguiente cambio de fase (solo funciona con la pestaña abierta).</li>'+
   '</ul><h4>Otras pestañas</h4><ul>'+
   '<li><b>🔑 Llaves</b> — todas las colecciones llave ordenadas por utilidad WL frente al precio. <code>wl_value</code> criterio editorial 0–10 · <code>util</code> GTD/FCFS/WL ponderado del registro de mints · <code>ce</code> = util ÷ floor (alto = infravalorada). Marca aquí lo que tienes.</li>'+
   '<li><b>🛒 Comprar</b> — lista corta de llaves top que aún no tienes, por prioridad y wl_value.</li>'+
   '<li><b>📉 Floors</b> — llaves cuyo floor se movió ±15% en 7 días. <b>🛒</b> marca una caída fuerte en una llave prioritaria.</li>'+
   '</ul>'},
 en:{tab_radar:'Radar',tab_keys:'Keys',tab_buy:'Buy',tab_floors:'Floors',
  h_now:'Minting now / open phase',h_soon:'Next 72 h',
  hide_low:'hide no-signal (no X, hype 0)',
  note_elig:'The feed does not include the eligible collection names for GTD/FCFS/WL: research them on X / site / OpenSea and log them with  node log-mint.mjs.',
  h_keys:'Key ranking — WL/GTD/FCFS utility vs. price',
  note_keys:'wl_value = editorial score 0–10 (key value per price). util = 1·GTD + 0.6·FCFS + 0.4·WL over logged mints. ce = util/floor (high = underpriced).',
  h_buy:'Buy priority',
  h_floors:'Floor alerts (±15% / 7 days)',
  note_floors:'Fills up as  node fetch-floors.mjs  accumulates history.',
  c_project:'Project',c_supply:'Minted',c_hype:'Hype',c_pop:'Popularity',c_x:'X activity',
  c_phases:'Phases',c_when:'When',c_price:'Public price',c_keys:'Keys',c_have:'Have',
  c_coll:'Collection',c_prio:'Prio',c_tier:'Tier',c_floor:'Floor',c_wl:'wl_value',c_ev:'GTD/FCFS/WL',c_note:'Note',
  c_before:'Floor before',c_after:'Floor now',
  now:'live',nothing_now:'nothing minting now',nothing_soon:'nothing in 72 h',no_hist:'no history yet',
  pop_hi:'HIGH',pop_mid:'MEDIUM',pop_lo:'LOW',pop_nox:'no X',
  x_fol:'followers',x_posts:'posts',x_age:'account age',days:'d',new_acct:'new account',
  need_unknown:'eligibility not researched',have_key:'YOU HAVE A KEY',in_wallet:'wallet holding this key',
  cartera:'keys across your wallets',cartera_none:'no keys detected in your wallets',
  save_hint:'Checked in this browser only. To save it to the file run:',
  save_local:'Saved in this browser (only you can see it).',
  sys_update:'auto-updates every 15 min',
  refresh:'Refresh',saved:'Saved to colecciones.json',refreshing:'Refreshing…',updated_ok:'Data updated ✓',
  rate_tip:'/15 min estimate from NFT Trencher 2 h rate (÷8). Becomes exact (no ~) once the monitor has run ≥15 min with serve.mjs.',
  rate_tip15:'Real rate: minted in the last ~15 min (computed by the monitor from OpenSea data)',
  no_market:'no market',thin_market:'thin market',closes:'closes',
  limit_tip:'Max NFTs per wallet in this phase',two_src:'confirmed by 2 sources',
  owners_tip:'Unique wallets holding at least one NFT, and what % of total minted that is. Near 100% = well spread. Low = few wallets hoarding many (🐳 if <45%).',
  fee_tip:'Creator fee / royalty: % the project takes on every resale',
  fee_lbl:'💸 royalty',
  vol_tip:'Sales volume in the last 24 h (floor currency)',
  alert_tip:'Notify me ~10 min before the next phase change (keep this tab open)',
  alert_set:'🔔 Alert on. I will warn you ~10 min before. Keep this tab open.',
  alert_set_toast:'🔔 Alert on (in-page only; browser notifications are blocked).',
  alert_off:'🔕 Alert removed',
  alert_body:'phase change in ~{m} min',
  legend:'Phases: <b class="ph-GTD">GTD</b> guaranteed spot · <b class="ph-FCFS">FCFS</b> first come first served · <b class="ph-WL">WL/Holder</b> generic list · <b>TEAM/PUBLIC</b> team / open to all.  <b>●</b> = open now · <s>struck</s> = ended · <b>×N</b> = NFTs per wallet',
  help:'<h3>How to read Monitor MINTS</h3>'+
   '<p>Live tracker for Robinhood Chain mints. Auto-updates every 15 min. Anything you tick is saved only in your browser.</p>'+
   '<h4>A Radar row</h4><ul>'+
   '<li><b>Project</b> — name + links (X / site / OpenSea). <code>live</code> = minting now, <code>SOON</code> = within 72 h, <b>✓✓</b> = confirmed by 2 sources.</li>'+
   '<li><b>Minted</b> — <code>373 / 4.4K</code> = minted / total supply. <b>⚡ +N/15m</b> = mint rate in the last 15 min (<code>~</code> = estimate). <b>👤 294 (79%)</b> = unique holder wallets and their share of minted: green ≥70% spread, amber 45–70%, red + 🐳 under 45% = few wallets hoarding.</li>'+
   '<li><b>Hype / Popularity / X activity</b> — feed hype score, a HIGH/MED/LOW read of the X account, and raw followers · posts · account age. A flagged age = account under 30 days old.</li>'+
   '<li><b>Phases</b> — one pill per phase with its price. <b class="ph-GTD">GTD</b> guaranteed spot · <b class="ph-FCFS">FCFS</b> first come first served · <b class="ph-WL">WL/Holder</b> generic list · <b>TEAM/PUBLIC</b> team / open to all. <b>●</b> open now · <s>struck</s> ended · <code>×N</code> max NFTs per wallet.</li>'+
   '<li><b>Keys</b> — which collections make you eligible for that mint. <b>⭐ YOU HAVE A KEY</b> if you own one; <i>eligibility not researched</i> = not figured out yet (allowlists are announced on X/Discord).</li>'+
   '<li><b>Public price</b> — public mint price ($ + ETH). <b>💸 royalty X%</b> = creator fee taken on every resale.</li>'+
   '<li><b>Floor</b> — secondary-market floor. <code>· 2.8×</code> = floor vs mint price (green up / red down); <code>FREE→$X</code> for free mints; <i>no / thin market</i> when sales are too few to trust.</li>'+
   '<li><b>When</b> — countdown + exact time (UTC and your local time). The <b>🔕/🔔</b> icon arms a heads-up ~10 min before the next phase change (only works while the tab is open).</li>'+
   '</ul><h4>Other tabs</h4><ul>'+
   '<li><b>🔑 Keys</b> — every key collection ranked by WL utility vs price. <code>wl_value</code> editorial 0–10 · <code>util</code> weighted GTD/FCFS/WL from the mint log · <code>ce</code> = util ÷ floor (high = underpriced). Tick what you own here.</li>'+
   '<li><b>🛒 Buy</b> — shortlist of top-tier keys you do not own yet, by priority and wl_value.</li>'+
   '<li><b>📉 Floors</b> — keys whose floor moved ±15% over 7 days. <b>🛒</b> marks a big drop on a high-priority key.</li>'+
   '</ul>'}
};
let L = localStorage.getItem('mints_lang') || (navigator.language||'es').slice(0,2);
if(!STR[L]) L='es';
const t = k => (STR[L][k] ?? k);

// --- X-style icons (line style, similar to x.com) ---
const IC = {
 fol:'<svg viewBox="0 0 24 24"><path d="M7.8 10a4.4 4.4 0 1 0 0-8.9 4.4 4.4 0 0 0 0 8.9Zm8.9.3c1.9 0 3.5-1.6 3.5-3.6S18.6 3 16.7 3c-.5 0-1 .1-1.4.3.6.9 1 2 1 3.2 0 1.1-.4 2.2-1 3.1.4.2.9.3 1.4.3ZM1.5 18.8c0-2.6 3-4.7 6.3-4.7s6.3 2.1 6.3 4.7v2.1H1.5v-2.1Zm14.6-4.4c2.6.3 4.9 2.1 4.9 4.4v2.1h-3.5v-2.1c0-1.7-.6-3.2-1.4-4.4Z"/></svg>',
 posts:'<svg viewBox="0 0 24 24"><path d="M1.75 3.25A2.25 2.25 0 0 1 4 1h16a2.25 2.25 0 0 1 2.25 2.25v12.5A2.25 2.25 0 0 1 20 18H8.6l-4.9 4v-4H4a2.25 2.25 0 0 1-2.25-2.25V3.25Z"/></svg>',
 age:'<svg viewBox="0 0 24 24"><path d="M7 2v2H5.5A2.5 2.5 0 0 0 3 6.5v13A2.5 2.5 0 0 0 5.5 22h13a2.5 2.5 0 0 0 2.5-2.5v-13A2.5 2.5 0 0 0 18.5 4H17V2h-2v2H9V2H7Zm-2 7h14v10.5a.5.5 0 0 1-.5.5h-13a.5.5 0 0 1-.5-.5V9Z"/></svg>'
};
const nf = n => n==null ? '?' : n>=1e6 ? (n/1e6).toFixed(1)+'M' : n>=1e3 ? (n/1e3).toFixed(1)+'K' : ''+n;
const xstat = (ic,val,title,cls='') => '<span class="xstat '+cls+'" title="'+title+'">'+IC[ic]+nf(val)+'</span>';

const usd = eth => eth==null ? null : eth*ETHUSD;
const fmtUsd = v => v==null ? '—' : '$'+(+v).toLocaleString(L==='es'?'es-ES':'en-US',{maximumFractionDigits: v<1?4:2});
const money = eth => {
  if(eth==null) return '—';
  if(eth===0) return 'FREE';
  return fmtUsd(usd(eth))+' <span class="eth">Ξ'+(+eth).toFixed(eth<0.01?5:4)+'</span>';
};
const esc = s => (s==null?'':String(s)).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const rel = ms => { if(!ms) return '—'; const h=(ms-Date.now())/3.6e6; if(h<0) return t('now'); return h<1?Math.round(h*60)+'m':h.toFixed(1)+'h'; };
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
const LOC = () => L==='es'?'es-ES':'en-US';
// hora local corta: "04:00" si es hoy, "3 sep 04:00" si es otro día
function localShort(ms){
  if(!ms) return '—';
  const d=new Date(ms), n=new Date();
  const hm=d.toLocaleTimeString(LOC(),{hour:'2-digit',minute:'2-digit'});
  if(d.toDateString()===n.toDateString()) return hm;
  return d.toLocaleDateString(LOC(),{day:'numeric',month:'short'})+' '+hm;
}
function whenCell(ms){
  if(!ms) return '—';
  const d = new Date(ms);
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()];
  const utc = String(d.getUTCDate()).padStart(2,'0')+' '+mon+' '+String(d.getUTCHours()).padStart(2,'0')+':'+String(d.getUTCMinutes()).padStart(2,'0')+' UTC';
  const loc = d.toLocaleTimeString(L==='es'?'es-ES':'en-US',{hour:'2-digit',minute:'2-digit'});
  return '<b>'+rel(ms)+'</b><br><span class="muted" style="font-size:11px">'+utc+' · "'+loc+'"</span>';
}
const links = m => [m.x&&'<a href="'+m.x+'" target="_blank">X</a>', m.site&&'<a href="'+m.site+'" target="_blank">web</a>', m.opensea&&'<a href="'+m.opensea+'" target="_blank">OpenSea</a>'].filter(Boolean).join(' · ')||'—';
const priceOf = s => { if(!s) return null; if(/free/i.test(s)) return 0; const m=String(s).match(/([\\d.]+)\\s*ETH/i); return m?+m[1]:null; };
const phases = arr => arr.map(x=>{
  let e=priceOf(x.p);
  if(e==null && x.usd!=null) e = ETHUSD ? x.usd/ETHUSD : null;
  const st = x.s==='live'?' live':x.s==='ended'?' ended':'';
  const dot = x.s==='live'?'● ':'';
  let when='';
  if(x.s==='live' && x.e) when=t('closes')+' '+localShort(x.e)+' ('+rel(x.e)+')';
  else if(x.s==='upcoming' && x.a) when=localShort(x.a)+' ('+rel(x.a)+')';
  const lim = x.lim ? '<span class="phlim" title="'+t('limit_tip')+'">×'+x.lim+'</span>' : '';
  const sub = when ? ' <span class="phwhen">'+when+'</span>' : '';
  return '<span class="phwrap"><span class="pill ph-'+x.k+st+'" title="'+(x.s||'')+'">'+dot+x.k+' '+(e==null?esc(x.p):money(e))+lim+'</span>'+sub+'</span>';
}).join(' ');

function popClass(p){ if(/ALTO|ALTA|HIGH/i.test(p)) return 'pop-hi'; if(/MEDIO|MEDIA|MEDIUM/i.test(p)) return 'pop-mid'; return 'pop-lo'; }
function popTxt(m){
  if(!m.x || m.xAgeDays<0) return '<span class="pop-lo">'+t('pop_nox')+'</span>';
  if(/ALTO/.test(m.pop)) return '<span class="pop-hi">'+t('pop_hi')+'</span>';
  if(/MEDIO/.test(m.pop)) return '<span class="pop-mid">'+t('pop_mid')+'</span>';
  return '<span class="pop-lo">'+t('pop_lo')+'</span>';
}
function xCell(m){
  if(!m.x) return '<span class="muted">—</span>';
  const young = m.xAgeDays>=0 && m.xAgeDays<30;
  return xstat('fol',m.xFollowers,t('x_fol'))
    + xstat('posts',m.xPosts,t('x_posts'))
    + xstat('age', m.xAgeDays>=0?m.xAgeDays:null, t('x_age') + (young?' — '+t('new_acct'):''), young?'xnew':'');
}
const publicPrice = m => { const g=m.phases.find(p=>/PUBLIC/i.test(p.k)); return g?priceOf(g.p):(m.priceEth??null); };

function needCell(m){
  const need = (m.need||[]).map(n=>({name:n.name, owned: isOwned(n.name), wallets: n.wallets||[]}));
  if(!need.length) return '<span class="muted" style="font-size:11px">'+t('need_unknown')+'</span>';
  const have = need.some(n=>n.owned);
  return (have?'<div class="have-key">⭐ '+t('have_key')+'</div>':'')
    + need.map(n=>{
        const w = n.wallets.length ? '<span class="wchip" title="'+t('in_wallet')+'">'+n.wallets.map(esc).join('/')+'</span>' : '';
        return '<span class="pill '+(n.owned?'k-own':'')+'">'+(n.owned?'✅ ':'')+esc(n.name)+w+'</span>';
      }).join(' ');
}

// ---- alertas por fila (solo mientras la pestaña esté abierta) ----
const ALERT_LEAD = 10*60000;               // avisa 10 min antes
const aKey = name => norm(name);
let armed = new Set(); let firedAt = {};
try{ armed = new Set(JSON.parse(localStorage.getItem('mints_alerts')||'[]')); }catch(e){}
try{ firedAt = JSON.parse(localStorage.getItem('mints_alerts_fired')||'{}'); }catch(e){}
const saveArmed = () => { try{ localStorage.setItem('mints_alerts', JSON.stringify([...armed])); }catch(e){} };
function saveFired(){
  const cut=Date.now()-2*864e5;
  for(const k in firedAt){ if(firedAt[k]<cut) delete firedAt[k]; }
  try{ localStorage.setItem('mints_alerts_fired', JSON.stringify(firedAt)); }catch(e){}
}
const isArmed = m => armed.has(aKey(m.name));
function futureTimes(m){
  const now=Date.now(), ts=[];
  for(const p of m.phases||[]){ if(p.a>now) ts.push(p.a); if(p.e>now) ts.push(p.e); }
  if(m.when>now) ts.push(m.when);
  return [...new Set(ts)].sort((a,b)=>a-b);
}
const nextTs = m => futureTimes(m)[0] || null;
async function toggleAlert(name){
  const k=aKey(name);
  if(armed.has(k)){ armed.delete(k); saveArmed(); render(); toast(t('alert_off')); return; }
  if('Notification' in window && Notification.permission==='default'){
    try{ await Notification.requestPermission(); }catch(e){}
  }
  armed.add(k); saveArmed(); render();
  toast(('Notification' in window && Notification.permission==='denied') ? t('alert_set_toast') : t('alert_set'));
}
function checkAlerts(){
  const now=Date.now();
  for(const m of D.mints){
    if(!isArmed(m)) continue;
    for(const ts of futureTimes(m)){
      const key=aKey(m.name)+'|'+ts;
      if(firedAt[key]) continue;
      if(now>=ts-ALERT_LEAD && now<ts){ firedAt[key]=now; saveFired(); fireAlert(m,ts); }
    }
  }
}
function fireAlert(m,ts){
  const mins=Math.max(1,Math.round((ts-Date.now())/60000));
  const msg=m.name+' — '+t('alert_body').replace('{m}',mins);
  if('Notification' in window && Notification.permission==='granted'){
    try{ new Notification('🚨 Monitor MINTS', { body: msg }); }catch(e){}
  }
  toast('🔔 '+msg, 12000);
  let n=0; const orig=document.title;
  const iv=setInterval(()=>{ document.title=(n%2?'🔔 ':'')+orig; if(++n>10){ clearInterval(iv); document.title=orig; } },1000);
}
const bellBtn = m => nextTs(m)==null ? '' :
  '<button class="bell'+(isArmed(m)?' on':'')+'" data-alert="'+esc(m.name)+'" title="'+t('alert_tip')+'">'+(isArmed(m)?'🔔':'🔕')+'</button> ';

const cell = (label,html,cls) => '<td'+(cls?' class="'+cls+'"':'')+' data-label="'+esc(label)+'">'+html+'</td>';
function mintRows(list){
  if(!list.length) return '';
  return list.map(m=>'<tr'+(m.need&&m.need.some(n=>isOwned(n.name))?' class="row-have"':'')+'>'+
    cell('', '<b>'+esc(m.name)+'</b> '+(m.status==='now'?'<span class="badge b-now">'+t('now')+'</span>':'')+(m.srcs===2?' <span class="v2" title="'+t('two_src')+'">✓✓</span>':'')+'<br><span class="muted" style="font-size:12px">'+links(m)+'</span>')+
    cell(t('c_supply'), nf(m.minted)+' / '+nf(m.supply)+rateCell(m)+ownersCell(m), 'num')+
    cell(t('c_hype'), m.hype, 'num')+
    cell(t('c_pop'), popTxt(m))+
    cell(t('c_x'), xCell(m))+
    cell(t('c_phases'), phases(m.phases)||'<span class="muted">—</span>')+
    cell(t('c_keys'), needCell(m))+
    cell(t('c_price'), money(publicPrice(m))+feeCell(m), 'num')+
    cell(t('c_floor'), floorRadar(m), 'num')+
    cell(t('c_when'), bellBtn(m)+whenCell(m.when), 'num')+
  '</tr>').join('');
}
// concentración: dueños únicos vs minteado. % alto = repartido; % bajo = acumulado.
function ownersCell(m){
  if(m.owners==null) return '';
  const pct = m.ownersPct!=null ? Math.round(m.ownersPct*100) : null;
  const cls = pct==null?'muted':pct>=70?'rise':pct>=45?'pop-mid':'drop';
  const whale = pct!=null && pct<45 ? ' 🐳' : '';
  return '<br><span class="'+cls+'" style="font-size:11px" title="'+t('owners_tip')+'">👤 '+nf(m.owners)+(pct!=null?' ('+pct+'%)':'')+whale+'</span>';
}
// creator fee (royalty) que cobra el proyecto en cada reventa
function feeCell(m){
  return m.fee!=null ? '<br><span class="eth" title="'+t('fee_tip')+'">'+t('fee_lbl')+' '+(+m.fee)+'%</span>' : '';
}
function rateCell(m){
  // ritmo real (muestras de OpenSea) si lo hay; si no, estimación desde el feed (2h/8)
  if(m.rate15!=null)
    return '<br><span class="pill" title="'+t('rate_tip15')+'">⚡ +'+m.rate15+'/15m</span>';
  const mm = m.mintRate && String(m.mintRate).match(/([\\d,]+)\\s*IN\\s*(\\d+)\\s*H/i);
  if(mm){
    const per2h = +mm[1].replace(/,/g,''), hrs = +mm[2] || 2;
    const est = Math.round(per2h / (hrs*4));  // por 15 min
    return '<br><span class="pill muted" title="'+t('rate_tip')+'">⚡ ~+'+est+'/15m</span>';
  }
  return '';
}
// $X  ·  Ξ0.00Y  (ETH)   /   $X USDG  (stablecoin)
function fPrice(usdV, ethV, sym){
  if(usdV==null) return '—';
  const u = fmtUsd(usdV);
  if(sym==='ETH' || sym==='WETH')
    return ethV!=null && ethV>0 ? u+' <span class="eth">Ξ'+(+ethV).toFixed(ethV<0.01?5:4)+'</span>' : u;
  if(sym && sym!=='ETH') return u+' <span class="eth">'+esc(sym)+'</span>';
  return u;
}
function floorRadar(m){
  if(m.floorUsd==null) return '<span class="muted">'+(m.floorThin?t('thin_market'):'—')+'</span>';
  if(m.floorUsd===0) return '<span class="muted">'+t('no_market')+'</span>';
  const pp = publicPrice(m);            // precio public en ETH
  const ppUsd = pp==null ? null : pp*ETHUSD;
  const head = fPrice(m.floorUsd, m.floorEth, m.floorSym);
  if(ppUsd==null) return head;
  if(pp===0) return head+' <span class="rise" style="font-size:11px">· FREE→'+fmtUsd(m.floorUsd)+'</span>';
  const mult = m.floorUsd/ppUsd;
  if(mult>1000) return head;
  return head+' <span class="'+(mult>=1?'rise':'drop')+'" style="font-size:11px">· '+mult.toFixed(1)+'×</span>';
}

function render(){
  document.documentElement.lang = L;
  document.querySelectorAll('[data-k]').forEach(el=>el.textContent = t(el.dataset.k));
  document.getElementById('legend').innerHTML = t('legend');
  document.querySelectorAll('#lang button').forEach(b=>b.classList.toggle('on',b.dataset.l===L));
  const cart = D.holdings
    ? ' · 👛 ' + (D.holdings.keys.length
        ? D.holdings.keys.length + ' ' + t('cartera') + ' (' + D.holdings.wallets.join(', ') + ')'
        : t('cartera_none'))
    : '';
  document.getElementById('upd').textContent =
    (L==='es'?'Actualizado: ':'Updated: ') + new Date(D.updated).toLocaleString(L==='es'?'es-ES':'en-US') +
    ' · ' + D.mints.length + ' mints · ' + D.ranking.length + (L==='es'?' colecciones':' collections') + cart +
    (D.public ? ' · ' + t('sys_update') : '');

  const HNOW='<tr><th>'+t('c_project')+'</th><th>'+t('c_supply')+'</th><th>'+t('c_hype')+'</th><th>'+t('c_pop')+
    '</th><th>'+t('c_x')+'</th><th>'+t('c_phases')+'</th><th>'+t('c_keys')+'</th><th>'+t('c_price')+'</th><th>'+t('c_floor')+'</th><th>'+t('c_when')+'</th></tr>';
  const nowL = D.mints.filter(m=>m.status==='now');
  let soonL = D.mints.filter(m=>m.status==='soon');
  if(document.getElementById('hideLow').checked) soonL = soonL.filter(m=>m.x || m.hype>0);
  document.getElementById('tNow').innerHTML = HNOW + (mintRows(nowL) || '<tr><td colspan=10 class=muted>'+t('nothing_now')+'</td></tr>');
  document.getElementById('tSoon').innerHTML = HNOW + (mintRows(soonL) || '<tr><td colspan=10 class=muted>'+t('nothing_soon')+'</td></tr>');

  document.getElementById('tKeys').innerHTML =
   '<tr><th>'+t('c_have')+'</th><th>#</th><th>'+t('c_coll')+'</th><th>'+t('c_prio')+'</th><th>'+t('c_tier')+'</th><th>'+t('c_floor')+
   '</th><th>'+t('c_wl')+'</th><th>'+t('c_ev')+'</th><th>util</th><th>ce</th><th>'+t('c_note')+'</th></tr>'+
   D.ranking.map((c,i)=>{const own=isOwned(c.name);return '<tr class="'+(own?'row-have':'')+'">'+
    cell(t('c_have'), '<input type="checkbox" class="ownchk" data-name="'+esc(c.name)+'"'+(own?' checked':'')+'>')+
    cell('#', (i+1), 'num')+
    cell(t('c_coll'), esc(c.name)+(own?' ✅':'')+(c.wallets&&c.wallets.length?' <span class="wchip" title="'+t('in_wallet')+'">'+c.wallets.map(esc).join('/')+'</span>':''), own?'owned':'')+
    cell(t('c_prio'), c.priority)+cell(t('c_tier'), c.tier)+
    cell(t('c_floor'), money(c.floorEth), 'num')+
    cell(t('c_wl'), (c.wlValue??'—'), 'num')+
    cell(t('c_ev'), c.gtd+'/'+c.fcfs+'/'+c.wl, 'num')+
    cell('util', c.util.toFixed(1), 'num')+
    cell('ce', (c.ce==null?'—':Math.round(c.ce)), 'num')+
    cell(t('c_note'), esc(c.notes), 'muted')+
   '</tr>';}).join('');

  const order=['🥇','🥈','💎','👑'];
  const buy = D.ranking.filter(c=>order.includes(c.priority) && !c.owned)
    .sort((a,b)=>order.indexOf(a.priority)-order.indexOf(b.priority) || (b.wlValue??0)-(a.wlValue??0));
  document.getElementById('tBuy').innerHTML =
   '<tr><th>'+t('c_prio')+'</th><th>'+t('c_coll')+'</th><th>'+t('c_floor')+'</th><th>'+t('c_wl')+'</th><th>'+t('c_note')+'</th></tr>'+
   buy.map(c=>'<tr>'+cell(t('c_prio'), c.priority)+cell(t('c_coll'), '<b>'+esc(c.name)+'</b>')+
    cell(t('c_floor'), money(c.floorEth), 'num')+
    cell(t('c_wl'), (c.wlValue??'—'), 'num')+cell(t('c_note'), esc(c.notes), 'muted')+'</tr>').join('');

  document.getElementById('tFloors').innerHTML =
   '<tr><th>'+t('c_coll')+'</th><th>'+t('c_prio')+'</th><th>'+t('c_before')+'</th><th>'+t('c_after')+'</th><th>Δ</th></tr>'+
   (D.alerts.map(a=>'<tr>'+cell(t('c_coll'), esc(a.name))+cell(t('c_prio'), a.priority)+
    cell(t('c_before'), money(a.from), 'num')+cell(t('c_after'), money(a.to), 'num')+
    cell('Δ', a.change.toFixed(0)+'%'+(a.change<=-15&&['👑','💎','🥇','🥈'].includes(a.priority)?' 🛒':''), 'num '+(a.change<0?'drop':'rise'))+'</tr>').join('')
    || '<tr><td colspan=5 class=muted>'+t('no_hist')+'</td></tr>');
}

document.getElementById('lang').addEventListener('click',e=>{
  const b=e.target.closest('button'); if(!b) return;
  L=b.dataset.l; localStorage.setItem('mints_lang',L); render();
  if(!helpM.hidden) fillHelp();
});
document.getElementById('hideLow').addEventListener('change',render);
document.addEventListener('change',e=>{
  const chk=e.target.closest('.ownchk'); if(!chk) return;
  setOwned(chk.dataset.name, chk.checked);
});
document.addEventListener('click',e=>{
  const b=e.target.closest('.bell'); if(!b) return;
  e.stopPropagation();
  toggleAlert(b.dataset.alert);
});
const rb=document.getElementById('refreshBtn');
if(rb) rb.addEventListener('click',()=>reload(true));
const helpM=document.getElementById('helpModal');
function fillHelp(){ document.getElementById('helpBody').innerHTML = t('help'); }
document.getElementById('helpBtn').addEventListener('click',()=>{ fillHelp(); helpM.hidden=false; });
document.getElementById('helpClose').addEventListener('click',()=>helpM.hidden=true);
helpM.addEventListener('click',e=>{ if(e.target===helpM) helpM.hidden=true; });
document.addEventListener('keydown',e=>{ if(e.key==='Escape') helpM.hidden=true; });
document.getElementById('tabs').addEventListener('click',e=>{
  const b=e.target.closest('button'); if(!b) return;
  document.querySelectorAll('#tabs button').forEach(x=>x.classList.toggle('on',x===b));
  document.querySelectorAll('section[data-p]').forEach(s=>s.hidden = s.dataset.p!==b.dataset.t);
});
document.addEventListener('click',e=>{
  const th=e.target.closest('th'); if(!th) return;
  const tb=th.closest('table'), i=[...th.parentNode.children].indexOf(th);
  const rows=[...tb.querySelectorAll('tr')].slice(1);
  const asc=th.dataset.asc==='1'; th.dataset.asc=asc?'0':'1';
  rows.sort((a,b)=>{const x=a.children[i]?.textContent.trim()||'',y=b.children[i]?.textContent.trim()||'';
    const nx=parseFloat(x.replace(/[^0-9.\\-]/g,'')),ny=parseFloat(y.replace(/[^0-9.\\-]/g,''));
    const v=(!isNaN(nx)&&!isNaN(ny))?nx-ny:x.localeCompare(y);return asc?-v:v;});
  rows.forEach(r=>tb.appendChild(r));
});
render();
setInterval(render, 60000); // los contadores bajan solos
checkAlerts();
setInterval(checkAlerts, 30000);
</script>
</body></html>`;
}
