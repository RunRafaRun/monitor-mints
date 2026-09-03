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

// agenda oficial del drop en OpenSea (SeaDrop). gql.opensea.io acepta queries
// ad-hoc; devuelve null en dropBySlug si el mint no usa SeaDrop.
const DROP_Q = `query($s:String!){dropBySlug(slug:$s){__typename` +
  ` ...on Erc721SeaDropV1{stages{label stageType startTime endTime maxTotalMintableByWallet price{usd token{unit symbol}}}}` +
  ` ...on Erc1155SeaDropV2{stages{label stageType startTime endTime maxTotalMintableByWallet price{usd token{unit symbol}}}}}}`;

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
        owners: null, fee: null, vol24: null, volTotal: null, listed: null,
        stages: cache[slug]?.stages ?? null, stagesAt: cache[slug]?.stagesAt ?? 0 };
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
      if (rec.bad) { rec.usd = rec.eth = rec.minted = rec.owners = rec.fee = rec.vol24 = rec.volTotal = rec.stages = null; }
      if (rec.minted != null) rec.samples = [...rec.samples, { m: rec.minted, at: now }].slice(-6);
      cache[slug] = rec;
      await new Promise((r) => setTimeout(r, 90));
    }
    try { writeFileSync(FLOOR_CACHE, JSON.stringify(cache) + "\n"); } catch {}
  }
  return cache;
}

// Agenda oficial del drop (SeaDrop) vía gql.opensea.io. Se consulta SOLO para los
// mints en curso / inminentes (no los ~60 slugs del floor) y con su propio TTL,
// porque el endpoint tiene un límite de ráfaga bajo. Muta y reescribe `cache`.
// dropBySlug devuelve null si el mint no usa SeaDrop -> nos quedamos sin agenda OS.
const STAGES_TTL = 30 * 60 * 1000; // 30 min (la agenda no cambia tan a menudo)
async function openseaDropStages(slugs, cache) {
  if (process.env.OS_DROP_STAGES === "0") return;
  const key = process.env.OPENSEA_API_KEY;
  const now = Date.now();
  // gql.opensea.io tiene un límite de ráfaga POR IP y persistente (~min). Si nos
  // penalizó hace poco, ni lo intentamos hasta que pase el cooldown.
  if ((cache.__gqlCooldown || 0) > now) return;
  const want = [...new Set(slugs.filter(Boolean))]
    .filter((s) => !(cache[s] && cache[s].bad) && now - ((cache[s] && cache[s].stagesAt) || 0) > STAGES_TTL);
  if (!want.length) return;
  let wrote = false;
  for (const slug of want.slice(0, 12)) {
    let r;
    try {
      r = await fetch("https://gql.opensea.io/graphql", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", ...(key ? { "x-api-key": key } : {}) },
        body: JSON.stringify({ query: DROP_Q, variables: { s: slug } }),
      });
    } catch { cache.__gqlCooldown = now + 15 * 60000; wrote = true; break; }
    if (r.status === 429) { cache.__gqlCooldown = now + 30 * 60000; wrote = true; break; } // corta y espera 30 min
    if (r.ok) {
      try {
        const st = (await r.json())?.data?.dropBySlug?.stages;
        const rec = cache[slug] || (cache[slug] = { at: 0 });
        rec.stagesAt = now;
        rec.stages = Array.isArray(st) && st.length ? st.map((x) => ({
          label: (x.label || "").trim() || null,
          type: x.stageType || null,
          a: Date.parse(x.startTime) || null,
          e: Date.parse(x.endTime) || null,
          lim: x.maxTotalMintableByWallet ?? null,
          unit: x.price?.token?.unit ?? null,
          usd: x.price?.usd ?? null,
        })) : null;
        wrote = true;
      } catch {}
    }
    await new Promise((res) => setTimeout(res, 500));
  }
  if (wrote) { try { writeFileSync(FLOOR_CACHE, JSON.stringify(cache) + "\n"); } catch {} }
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

  // redes soportadas (id del feed/WLMT -> etiqueta corta para el dashboard)
  const CHAINS = [
    { id: "robinhood", label: "RH", name: "Robinhood Chain" },
    { id: "ethereum", label: "ETH", name: "Ethereum" },
    { id: "ink", label: "Ink", name: "Ink" },
    { id: "base", label: "Base", name: "Base" },
  ];

  let cards = [];
  for (const { id } of CHAINS) {
    try {
      const cc = await fetchFeed(id);
      for (const c of cc) c.chain = c.chain || id;
      cards.push(...cc);
    } catch (e) { console.error(`feed ${id}:`, e.message); }
  }

  // dedup por (red + nombre): la tarjeta con más señal
  const seen = new Map();
  for (const c of cards) {
    const k = (c.chain || "robinhood") + "|" + c.name.toLowerCase();
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
        name: c.name, status, chain: c.chain || "robinhood",
        minted: c.minted, supply: c.supply, mintRate: c.mintRate,
        hype: c.hype ?? 0, tier: c.tier, team: c.team,
        xFollowers: c.xFollowers, xPosts: c.xPosts, xAgeDays: c.xAgeDays, socials: c.socials,
        pop: popularityVerdict(c),
        priceEth: c.priceEth ?? null, free: !!c.free,
        when: (openGate || nextGate)?.startMs ?? c.startMs ?? null,
        phases: c.gates.filter((g) => g.kind !== "OTHER").map((g) => ({ k: g.kind, n: (g.label || g.name || "").trim() || null, p: g.price || g.priceText || "?", s: g.state, a: g.startMs, e: g.endMs, lim: g.perWallet })),
        need, haveKey: need.some((n) => n.owned),
        x: c.x, site: c.site, opensea: c.opensea, slug: c.openseaSlug || null,
        contract: (c.contract || "").toLowerCase() || null,
        srcs: 1,
      };
    })
    .filter((m) => m.status !== "later");

  // --- fuente secundaria: cruce y complemento ---
  let extra = [];
  for (const { id } of CHAINS) {
    const rows = await fetchDailyMints(id).catch(() => []);
    for (const r of rows) r.chain = r.chain || id;
    extra.push(...rows);
  }
  if (extra.length) {
    const byName = new Map(mints.map((m) => [m.chain + "|" + norm(m.name), m]));
    const bySlug = new Map(mints.filter((m) => m.slug).map((m) => [m.slug, m]));
    const KEYK = ["GTD", "FCFS", "WL", "HOLDER", "TEAM"];
    const phaseWhen = (ph) => {
      const live = ph.find((p) => p.startMs && p.endMs && p.startMs <= now && p.endMs > now);
      const next = ph.filter((p) => p.startMs && p.startMs > now).sort((a, b) => a.startMs - b.startMs)[0];
      return { live, next };
    };
    for (const e of extra) {
      const hit = (e.slug && bySlug.get(e.slug)) || byName.get(e.chain + "|" + norm(e.name));
      if (hit) {
        hit.srcs = 2;
        if (!hit.supply && e.supply) hit.supply = e.supply;
        if (!hit.contract && e.contract) hit.contract = e.contract;
        if (!hit.slug && e.slug) hit.slug = e.slug;
        // completar precio USD / allocation + cruzar HORARIOS por tipo de fase
        for (const ep of e.phases) {
          const tp = hit.phases.find((p) => p.k === ep.kind);
          if (!tp) continue;
          if (ep.priceUsd != null && tp.usd == null) tp.usd = ep.priceUsd;
          if (ep.allocation != null && tp.lim == null) tp.lim = ep.allocation;
          // Las 2 fuentes discrepan a menudo en las horas (una queda desfasada tras
          // un cambio de agenda). Los mints casi siempre se retrasan o se alargan,
          // nunca se adelantan -> nos quedamos con la hora más TARDÍA de las dos.
          if (ep.startMs && (tp.a == null || ep.startMs > tp.a)) tp.a = ep.startMs;
          if (ep.endMs && (tp.e == null || ep.endMs > tp.e)) tp.e = ep.endMs;
        }
        // recalcula estado de cada fase + "when" + status con los horarios ya cruzados
        for (const p of hit.phases) {
          if (p.a != null || p.e != null)
            p.s = (p.a ?? 0) <= now && (p.e ?? 1e18) > now ? "live"
              : p.e != null && p.e < now ? "ended" : "upcoming";
        }
        const openK2 = hit.phases.find((p) => KEYPHASE.includes(p.k) && (p.a ?? 0) <= now && (p.e ?? 0) > now);
        const liveP2 = hit.phases.find((p) => (p.a ?? 0) <= now && (p.e ?? 1e18) > now);
        const nextP2 = hit.phases.filter((p) => (p.a ?? 0) > now).sort((a, b) => a.a - b.a)[0];
        hit.when = (openK2 || liveP2 || nextP2)?.a ?? hit.when;
        if (liveP2 && hit.status !== "now") hit.status = "now";
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
          name: e.name, status, chain: e.chain || "robinhood",
          minted: null, supply: e.supply, mintRate: null,
          hype: 0, tier: null, team: null,
          xFollowers: null, xPosts: null, xAgeDays: -1, socials: 0,
          pop: "🔴 sin X",
          priceEth: null, free: e.phases.some((p) => p.free),
          when: (live || next)?.startMs ?? e.mintDate ?? null,
          phases: e.phases.filter((p) => p.kind !== "OTHER").map((p) => ({
            k: p.kind, n: (p.label || "").trim() || null,
            p: p.free ? "FREE" : p.priceEth != null ? p.priceEth + " ETH" : "?",
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

  // slug de OpenSea por nombre (data/opensea-slugs.json, lo puebla resolve-slugs.mjs)
  const slugsPath = join(ROOT, "data", "opensea-slugs.json");
  const slugMap = existsSync(slugsPath) ? JSON.parse(readFileSync(slugsPath, "utf8")) : {};
  const slugFor = (name) => {
    if (slugMap[name] && !/^_/.test(name)) return slugMap[name];
    const hit = Object.keys(slugMap).find((k) => !/^_/.test(k) && norm(k) === norm(name));
    return hit ? slugMap[hit] : null;
  };
  // completa slug (para floors / agenda / elegibilidad) y el enlace a OpenSea de la fila
  for (const m of mints) if (!m.slug) m.slug = slugFor(m.name);
  // los mints nuevos aún no están en opensea-slugs.json -> resolver por contrato en
  // vivo (lo que hace resolve-slugs.mjs). Caché propia en data/contract-slugs.json.
  {
    const csPath = join(ROOT, "data", "contract-slugs.json");
    let cs = {}; try { cs = JSON.parse(readFileSync(csPath, "utf8")); } catch { /**/ }
    const key = process.env.OPENSEA_API_KEY;
    const need = mints.filter((m) => !m.slug && m.contract).slice(0, 12);
    let wrote = false;
    for (const m of need) {
      const c = m.contract.toLowerCase();
      if (!(c in cs) && key) {
        try {
          const r = await fetch(`https://api.opensea.io/api/v2/chain/${m.chain || "robinhood"}/contract/${c}`,
            { headers: { "x-api-key": key, accept: "application/json" } });
          cs[c] = r.ok ? ((await r.json())?.collection || null) : null;
        } catch { cs[c] = null; }
        wrote = true;
        await new Promise((res) => setTimeout(res, 120));
      }
      if (cs[c]) m.slug = cs[c];
    }
    if (wrote) { try { writeFileSync(csPath, JSON.stringify(cs, null, 1) + "\n"); } catch { /**/ } }
  }
  for (const m of mints) if (!m.opensea && m.slug) m.opensea = `https://opensea.io/collection/${m.slug}`;

  // floor + minteados en vivo desde OpenSea (el feed trae el minted desfasado)
  const ETHUSD = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd")
    .then((r) => r.json()).then((j) => j.ethereum.usd).catch(() => db.meta.eth_usd_ref || 2400);
  const os = await openseaForSlugs(mints.map((m) => ({ slug: m.slug, contract: m.contract })), ETHUSD);
  // agenda oficial del drop: solo para los mints en curso / inminentes
  await openseaDropStages(mints.filter((m) => m.status === "now" || m.status === "soon").map((m) => m.slug), os);
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

  // ── OpenSea MANDA ─────────────────────────────────────────────────────────
  // Si el mint usa SeaDrop, gql.opensea.io da la agenda oficial (la misma que se
  // ve en la web de Robinhood). Sustituye a la del feed / WLMT, que se quedan
  // desfasadas cuando el proyecto cambia horarios a mitad del drop.
  const osStageKind = (type, label) => {
    const u = (label || "").toUpperCase();
    if (type === "PUBLIC_SALE" || /PUBLIC/.test(u)) return "PUBLIC";
    if (/FCFS/.test(u)) return "FCFS";
    if (/\bGTD\b|GUARANTEED/.test(u)) return "GTD";
    if (/TEAM|TREASURY|PARTNER|VAULT|RESERVE/.test(u)) return "TEAM";
    if (/HOLDER/.test(u)) return "HOLDER";
    return "WL"; // SIGNED_PRESALE genérico -> lista de acceso
  };
  for (const m of mints) {
    const oo = m.slug ? os[m.slug] : null;
    const stg = oo && !oo.bad ? oo.stages : null;
    if (!Array.isArray(stg) || !stg.length) continue;
    const prev = m.phases || [];
    m.phases = stg
      .slice()
      .sort((a, b) => (a.a ?? 0) - (b.a ?? 0))
      .map((x) => {
        const k = osStageKind(x.type, x.label);
        const free = x.unit === 0 || (x.unit == null && x.usd === 0);
        return {
          k, n: x.label || prev.find((p) => p.k === k)?.n || null,
          p: free ? "FREE" : x.unit != null ? x.unit + " ETH" : "?",
          s: (x.a ?? 0) <= now && (x.e ?? 1e18) > now ? "live" : x.e && x.e < now ? "ended" : "upcoming",
          a: x.a, e: x.e, lim: x.lim, usd: x.usd,
        };
      });
    m.schedSrc = "opensea";
    const openK = m.phases.find((p) => KEYPHASE.includes(p.k) && (p.a ?? 0) <= now && (p.e ?? 0) > now);
    const liveP = m.phases.find((p) => (p.a ?? 0) <= now && (p.e ?? 1e18) > now);
    const nextP = m.phases.filter((p) => (p.a ?? 0) > now).sort((a, b) => a.a - b.a)[0];
    m.when = (openK || liveP || nextP)?.a ?? m.when;
    if (liveP) m.status = "now";
    else if (nextP && nextP.a <= soonCut && m.status === "later") m.status = "soon";
  }

  // elegibilidad real de TU wallet por fase (data/eligibility-wallet.json, lo
  // escribe fetch-eligibility.mjs con una sesión de OpenSea). Personal: fuera del
  // modo público. Se cruza por slug con cada mint del radar.
  let weMeta = null;
  if (!pub) {
    const wePath = join(ROOT, "data", "eligibility-wallet.json");
    if (existsSync(wePath)) {
      try {
        const we = JSON.parse(readFileSync(wePath, "utf8"));
        for (const m of mints) {
          const d = m.slug ? we.drops?.[m.slug] : null;
          if (!d) continue;
          const stages = (d.stages || [])
            .filter((s) => s.eligible !== null || s.wlCount != null)
            .map((s) => ({ k: s.kind, label: s.label, eligible: s.eligible, wlCount: s.wlCount }));
          if (stages.length) m.wlElig = { wallet: we.wallet?.label || null, stages };
        }
        weMeta = { updated: we.updated, expiresAt: we.expiresAt, wallet: we.wallet?.label || null };
      } catch (e) { console.error("eligibility-wallet.json:", e.message); }
    }
  }


  // colecciones-llave: RH en colecciones.json + un fichero por red extra
  const collFiles = { ethereum: "colecciones-eth.json", ink: "colecciones-ink.json", base: "colecciones-base.json" };
  const allColls = db.collections.map((c) => ({ ...c, chain: c.chain || "robinhood" }));
  for (const [ch, f] of Object.entries(collFiles)) {
    const p = join(ROOT, "data", f);
    if (!existsSync(p)) continue;
    try {
      const j = JSON.parse(readFileSync(p, "utf8"));
      for (const c of j.collections || []) allColls.push({ ...c, chain: ch });
    } catch (e) { console.error(`${f}:`, e.message); }
  }

  const ranking = allColls
    .map((c) => {
      const slug = c.slug || slugFor(c.name);
      return {
      name: c.name, chain: c.chain, priority: c.priority || "", tier: c.tier,
      floorEth: c.floor_eth, floorUsd: c.floor_usd, wlValue: c.wl_value,
      gtd: c.gtd || 0, fcfs: c.fcfs || 0, wl: c.wl || 0,
      util: demonstratedUtility(c), ce: costEfficiency(c), owned: !!c.owned,
      wallets: walletsByColl.get(norm(c.name)) || [],
      notes: c.notes || "",
      opensea: slug ? `https://opensea.io/collection/${slug}` : null,
    };
    })
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

  // solo ofrecemos en el selector las redes que traen algo
  const present = new Set([...mints.map((m) => m.chain), ...ranking.map((r) => r.chain)]);
  const chains = CHAINS.filter((c) => present.has(c.id));
  // cartera / P&L (data/trades.json, lo escribe fetch-trades.mjs). Personal.
  let trades = null;
  if (!pub) {
    const tPath = join(ROOT, "data", "trades.json");
    if (existsSync(tPath)) { try { trades = JSON.parse(readFileSync(tPath, "utf8")); } catch (e) { console.error("trades.json:", e.message); } }
  }

  const out = { updated: new Date().toISOString(), ethUsd: ETHUSD, mints, ranking, alerts, holdings: holdSummary, chains, public: !!pub, wlElig: weMeta, trades };
  return pub ? stripPersonal(out) : out;
}

// Quita del payload todo lo que revele la cartera del usuario.
function stripPersonal(d) {
  for (const c of d.ranking) { c.owned = false; c.wallets = []; }
  for (const m of d.mints) {
    m.haveKey = false;
    for (const n of m.need || []) { n.owned = false; n.wallets = []; }
    delete m.wlElig;
  }
  d.holdings = null;
  d.wlElig = null;
  d.trades = null;
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
${data.public ? '<meta http-equiv="refresh" content="600">' : ""}
<title>Monitor MINTS</title>
<link rel="icon" id="fav" href="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><text x="6" y="52" font-size="52">🚨</text></svg>')}">
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
tr.row-spot td{background:color-mix(in srgb,var(--gold) 13%,transparent)}
tr.row-have.row-spot td{background:color-mix(in srgb,var(--gold) 13%,transparent)}
.have-spot{color:var(--gold);font-weight:700;font-size:11px;margin-bottom:2px}
.wl-elig{font-size:11px;margin-bottom:3px}
.wl-elig-yes{font-weight:700}
.pill.wl-in{color:var(--now);font-weight:700;border-color:color-mix(in srgb,var(--now) 60%,var(--line));background:color-mix(in srgb,var(--now) 12%,transparent)}
.pill.wl-out{color:var(--mut);border-style:dashed;opacity:.75}
.wl-hdr{margin-left:8px;font-size:11px;color:var(--mut);white-space:nowrap}
.wl-hdr b{color:var(--now)}
.wl-hdr.warn b{color:var(--warn)}
.wl-btn{margin-left:6px}
.wstats{display:flex;flex-wrap:wrap;gap:10px;margin:8px 14px 4px}
.wstat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px 14px;min-width:120px}
.wstat .k{font-size:10px;color:var(--mut);text-transform:uppercase;letter-spacing:.04em}
.wstat .v{font-size:16px;font-weight:700;font-variant-numeric:tabular-nums;margin-top:2px}
.wstat .v small{font-size:11px;font-weight:400;color:var(--mut)}
.pnl-pos{color:var(--now)}.pnl-neg{color:var(--warn)}
.wflag{display:inline-block;font-size:9px;padding:0 4px;border-radius:4px;border:1px solid var(--line);color:var(--mut);margin-left:3px;text-transform:uppercase}
.pill.spot{border-color:color-mix(in srgb,var(--gold) 50%,var(--line))}
.pill.spot-on{color:var(--gold);font-weight:700;border-color:color-mix(in srgb,var(--gold) 75%,var(--line))}
.spot-form{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:10px 14px 4px}
.spot-form input{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:6px 10px;font-size:13px}
.spot-form input::placeholder{color:var(--mut)}
.spqty{width:54px;background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:3px 6px;font-size:12px}
.spphase{display:flex;align-items:center;gap:5px;margin:2px 0}
.sp-on{color:var(--now);font-weight:700}
.sp-pend{color:var(--gold);font-weight:700}
.spassign,.spnote{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:3px 6px;font-size:12px}
.spassign{margin-left:6px}
.spnote{width:100%;max-width:230px}
.spnote::placeholder{color:var(--mut)}
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
.filtrow{margin-top:10px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
#q{width:100%;max-width:440px;background:var(--card);color:var(--fg);border:1px solid var(--line);
border-radius:8px;padding:7px 12px;font-size:13px}
#q::placeholder{color:var(--mut)}
.filtrow .chk{margin:0}
.oslink{font-size:11px;white-space:nowrap}
tr[hidden]{display:none}
#alertMenu{position:fixed;z-index:60;background:var(--card);border:1px solid var(--line);border-radius:10px;
padding:5px;box-shadow:0 12px 40px rgba(0,0,0,.45);min-width:150px}
#alertMenu .am-h{font-size:10px;color:var(--mut);text-transform:uppercase;letter-spacing:.04em;padding:4px 8px 2px}
#alertMenu button{display:block;width:100%;text-align:left;background:transparent;border:0;color:var(--fg);
font-size:12.5px;padding:6px 8px;border-radius:6px;cursor:pointer}
#alertMenu button:hover{background:color-mix(in srgb,var(--accent) 22%,transparent)}
#alertMenu button.sel{color:var(--now);font-weight:700}
#alertBanner{position:fixed;top:0;left:0;right:0;z-index:70;background:var(--warn);color:#fff;
padding:10px 14px;font-size:13.5px;font-weight:600;display:flex;flex-direction:column;gap:5px;
box-shadow:0 6px 24px rgba(0,0,0,.5);animation:abflash .8s ease-in-out 4}
#alertBanner[hidden]{display:none}
@keyframes abflash{0%,100%{filter:brightness(1)}50%{filter:brightness(1.35)}}
#alertBanner .ab-row{display:flex;justify-content:space-between;align-items:center;gap:12px}
#alertBanner button{background:rgba(255,255,255,.22);border:0;color:#fff;border-radius:6px;cursor:pointer;
padding:3px 9px;font-size:12px;font-weight:700;flex:none}
#alertBanner .ab-all{align-self:flex-end}
.chains{display:flex;gap:5px;margin-top:10px;flex-wrap:wrap}
.chains[hidden]{display:none}
.chains button{background:var(--card);color:var(--mut);border:1px solid var(--line);border-radius:999px;
padding:3px 11px;cursor:pointer;font-size:12px}
.chains button.on{background:var(--accent);color:#fff;border-color:var(--accent)}
.chpill{font-size:9px;padding:1px 4px;border:1px solid var(--line);border-radius:4px;color:var(--mut);
vertical-align:middle;text-transform:uppercase;letter-spacing:.03em}

#hdrToggle{display:none}

/* ---- móvil: cada fila pasa a ficha ---- */
@media (max-width:860px){
  header{padding:10px}
  #hdrToggle{display:inline-flex}
  header.hcollapsed .sub,
  header.hcollapsed .chains,
  header.hcollapsed .filtrow{display:none}
  #q{max-width:none}
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
  tr.row-spot{outline:2px solid color-mix(in srgb,var(--gold) 60%,transparent)}
  .hm-box{padding:18px 16px}
}
</style></head><body>
<div class="wrap">
<header>
  <div class="hrow">
    <h1 id="h1">🚨 Monitor MINTS</h1>
    <div style="display:flex;gap:8px;align-items:center">
      ${served ? '<button id="refreshBtn" class="chk" style="border-radius:8px"><span data-k="refresh"></span></button>' : ""}
      <button id="hdrToggle" class="chk" style="border-radius:8px;font-weight:700">☰</button>
      <button id="helpBtn" class="chk" style="border-radius:8px;font-weight:700" title="?">?</button>
      <div class="lang" id="lang"><button data-l="es">ES</button><button data-l="en">EN</button></div>
    </div>
  </div>
  <div class="sub" id="upd"></div>
  <div class="sub" id="wlBar" hidden></div>
  <div class="tabs" id="tabs">
    <button data-t="radar" class="on">🔥 <span data-k="tab_radar"></span></button>
    <button data-t="keys">🔑 <span data-k="tab_keys"></span></button>
    <button data-t="buy">🛒 <span data-k="tab_buy"></span></button>
    <button data-t="floors">📉 <span data-k="tab_floors"></span></button>
    <button data-t="spots">🎟️ <span data-k="tab_spots"></span></button>
    <button data-t="wallet">💰 <span data-k="tab_wallet"></span></button>
  </div>
  <div class="chains" id="chains" hidden></div>
  <div class="filtrow">
    <input id="q" type="search" autocomplete="off" spellcheck="false">
    <label class="chk"><input type="checkbox" id="onlyKeys"> <span data-k="only_keys"></span></label>
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

<section data-p="spots" hidden>
  <h2 data-k="h_spots"></h2>
  <p class="note" data-k="note_spots"></p>
  <div class="spot-form">
    <input id="spName" list="spNames" autocomplete="off" spellcheck="false">
    <datalist id="spNames"></datalist>
    <input id="spPhase" list="spPhases" autocomplete="off" spellcheck="false" style="width:150px">
    <datalist id="spPhases"><option>GTD</option><option>FCFS</option><option>WL</option><option>HOLDER</option><option>PUBLIC</option><option>TEAM</option><option>OG</option></datalist>
    <input id="spQty" type="number" min="1" value="1" style="width:64px">
    <button id="spAdd" class="chk" data-k="spot_add"></button>
  </div>
  <div class="scroll"><table id="tSpots"></table></div>
  <p class="note" id="spPending"></p>
</section>

<section data-p="wallet" hidden>
  <h2 data-k="h_wallet"></h2>
  <div id="wStats" class="wstats"></div>
  <div class="filtrow" style="margin:6px 14px 0">
    <label class="chk"><input type="checkbox" id="wRealOnly"> <span data-k="w_real_only"></span></label>
    <label class="chk"><input type="checkbox" id="wHeldHide"> <span data-k="w_hide_held"></span></label>
  </div>
  <div class="scroll"><table id="tWallet"></table></div>
  <p class="note" data-k="w_note"></p>
</section>
</div>

<div id="alertBanner" hidden></div>

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

// ---- Plazas confirmadas (local a este navegador, como los checkboxes de llaves) ----
// spotsDB[norm(nombre)] = { name, phases:[{k,qty}], note }
// Un proyecto sin fecha de mint (no está en el radar) queda "pendiente"; en cuanto
// aparece en el radar con el mismo nombre se asigna solo (spotFor cruza por norm()).
let spotsDB = {};
try { spotsDB = JSON.parse(localStorage.getItem('mints_spots')||'{}'); } catch(e){}
let spotsSeen = {};   // norm(nombre) -> ts de cuando se vio por primera vez en el radar
try { spotsSeen = JSON.parse(localStorage.getItem('mints_spots_seen')||'{}'); } catch(e){}
function saveSpots(){ try { localStorage.setItem('mints_spots', JSON.stringify(spotsDB)); } catch(e){} }
function saveSpotsSeen(){ try { localStorage.setItem('mints_spots_seen', JSON.stringify(spotsSeen)); } catch(e){} }
const spotFor = name => spotsDB[norm(name)] || null;
const mintKnown = k => (D.mints||[]).some(m=>norm(m.name)===k);
function addSpot(name, phase, qty){
  name  = String(name||'').trim();
  phase = String(phase||'').trim().toUpperCase().replace(/[\\s_]+/g,'');
  qty   = Math.max(1, parseInt(qty,10) || 1);
  if(!name || !phase) return;
  const k = norm(name);
  const e = spotsDB[k] || (spotsDB[k] = { name, phases: [], note: '' });
  e.name = name;
  const ex = e.phases.find(p=>p.k===phase);
  if(ex) ex.qty = qty; else e.phases.push({ k: phase, qty });
  const known = mintKnown(k);
  if(known && !spotsSeen[k]){ spotsSeen[k] = Date.now(); saveSpotsSeen(); }   // ya está en el radar: no avisar luego
  saveSpots(); render();
  if(!known && typeof toast==='function') toast(t('sp_added_pending'), 7000);
}
function removeSpot(k, phase){
  const e = spotsDB[k]; if(!e) return;
  e.phases = e.phases.filter(p=>p.k!==phase);
  if(!e.phases.length){ delete spotsDB[k]; delete spotsSeen[k]; saveSpotsSeen(); }
  saveSpots(); render();
}
function removeProject(k){
  if(!spotsDB[k]) return;
  delete spotsDB[k]; delete spotsSeen[k];
  saveSpots(); saveSpotsSeen(); render();
}
function setSpotQty(k, phase, qty){
  const e = spotsDB[k]; if(!e) return;
  const p = e.phases.find(x=>x.k===phase); if(!p) return;
  p.qty = Math.max(1, parseInt(qty,10) || 1);
  saveSpots();
}
function setSpotNote(k, v){
  const e = spotsDB[k]; if(!e) return;
  e.note = String(v||'').slice(0,200);
  saveSpots();
}
// asignar manualmente una plaza pendiente a un mint del radar (nombre distinto)
function reassignSpot(oldKey, newName){
  const e = spotsDB[oldKey]; if(!e) return;
  newName = String(newName||'').trim();
  const nk = norm(newName);
  if(!nk || nk===oldKey) return;
  const tgt = spotsDB[nk];
  if(tgt){
    for(const p of e.phases){ const x = tgt.phases.find(y=>y.k===p.k); if(x) x.qty = Math.max(x.qty, p.qty); else tgt.phases.push(p); }
    tgt.name = newName;
    if(!tgt.note) tgt.note = e.note || '';
  } else {
    spotsDB[nk] = { name: newName, phases: e.phases, note: e.note || '' };
  }
  delete spotsDB[oldKey]; delete spotsSeen[oldKey];
  if(mintKnown(nk)) spotsSeen[nk] = Date.now();
  saveSpots(); saveSpotsSeen(); render();
}
// aviso cuando una plaza pendiente entra en el radar (el proyecto ya tiene fecha)
function checkSpotsMatched(){
  const fresh = [];
  for(const k of Object.keys(spotsDB)){
    if(mintKnown(k)){ if(!spotsSeen[k]){ spotsSeen[k] = Date.now(); fresh.push(spotsDB[k].name); } }
    else if(spotsSeen[k]){ delete spotsSeen[k]; }   // salió del radar: rearmar por si vuelve
  }
  saveSpotsSeen();
  if(fresh.length && typeof toast==='function'){
    toast(t('sp_now_live').replace('{p}', fresh.join(', ')), 12000);
    try { beep(); } catch(e){}
  }
}
function spotBadge(m){
  const s = spotFor(m.name); if(!s || !s.phases.length) return '';
  const kinds = new Set((m.phases||[]).map(p=>p.k));
  return '<div class="have-spot">🎟️ '+t('spot_lbl')+' '+
    s.phases.slice().sort((a,b)=>a.k.localeCompare(b.k))
      .map(p=>'<span class="pill spot'+(kinds.has(p.k)?' spot-on':'')+'">'+esc(p.k)+' ×'+p.qty+'</span>').join(' ')+
    (s.note ? ' <span class="muted" style="font-weight:400">'+esc(s.note)+'</span>' : '')+
    '</div>';
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

// ---- Sesión de OpenSea + elegibilidad real de la wallet ----
let wlStatus = null;   // {connected,address,label,expiresAt,cliAvailable} (solo modo servidor)
async function fetchWlStatus(){
  if(!SERVED) return null;
  try{ const r=await fetch('api/opensea/status',{cache:'no-store'}); if(r.ok) wlStatus=await r.json(); }catch(e){}
  renderWlBar(); return wlStatus;
}
function wlExpTxt(ts){
  if(!ts) return '';
  const m=Math.round((ts-Date.now())/60000);
  if(m<=0) return ' · '+t('wl_expired');
  const v = m<60 ? m+'m' : m<96*60 ? Math.round(m/60)+'h'
    : new Date(ts).toLocaleDateString(L==='es'?'es-ES':'en-US',{day:'numeric',month:'short'});
  return ' · '+t('wl_expires')+' '+v;
}
const wlShort=a=>a?a.slice(0,6)+'…'+a.slice(-4):'';
function renderWlBar(){
  const bar=document.getElementById('wlBar'); if(!bar) return;
  const meta=D&&D.wlElig, s=wlStatus;
  if(!SERVED && !meta){ bar.hidden=true; return; }
  let h='🔎 <b>'+t('wl_conn')+'</b> ';
  if(s&&s.connected){
    h+='· '+(s.label?esc(s.label)+' ':'')+wlShort(s.address)+wlExpTxt(s.expiresAt)
      +' <button class="chk wl-btn" data-wl="refresh">'+t('wl_refresh')+'</button>'
      +' <button class="chk wl-btn" data-wl="login">'+t('wl_reconnect')+'</button>';
  } else if(meta){
    h+='· '+(meta.wallet?esc(meta.wallet)+' ':'')+(meta.expiresAt?wlExpTxt(meta.expiresAt).replace(/^ · /,''):'')
      +(SERVED?' <button class="chk wl-btn" data-wl="login">'+t('wl_reconnect')+'</button>':'');
  } else if(SERVED){
    h += (s&&s.cliAvailable===false)
      ? '— <span class="muted">'+t('wl_need_cli')+'</span>'
      : '<button class="chk wl-btn" data-wl="login">'+t('wl_connect')+'</button>';
  } else { bar.hidden=true; return; }
  bar.innerHTML=h; bar.hidden=false;
}
async function wlRefresh(){
  toast(t('wl_checking'), 120000);
  try{ await fetch('api/eligibility/refresh',{method:'POST'}); }catch(e){ toast('⚠️ '+e.message); return; }
  for(let i=0;i<60;i++){
    await new Promise(x=>setTimeout(x,3000));
    await fetchWlStatus();
    if(wlStatus && !wlStatus.eligRunning) break;
  }
  await reload();
  toast(t('wl_checked'));
}
document.addEventListener('click',async e=>{
  const b=e.target.closest('[data-wl]'); if(!b) return;
  if(!SERVED){ toast(t('wl_server_only'), 9000); return; }
  const act=b.dataset.wl; b.disabled=true;
  try{
    if(act==='refresh'){ await wlRefresh(); }
    else if(act==='login'){
      await fetchWlStatus();
      if(wlStatus&&wlStatus.connected){ await wlRefresh(); b.disabled=false; return; }
      toast(t('wl_connecting'), 8000);
      const r=await fetch('api/opensea/login',{method:'POST'});
      const j=await r.json().catch(()=>({}));
      if(j.error==='no-cli'){ toast(t('wl_need_cli'), 14000); b.disabled=false; return; }
      if(j.url){ const w=window.open(j.url,'_blank','noopener'); if(!w) toast(t('wl_popup')+' '+j.url, 20000); }
      else { toast(t('wl_no_url'), 16000); b.disabled=false; return; }
      for(let i=0;i<60 && !(wlStatus&&wlStatus.connected);i++){ await new Promise(x=>setTimeout(x,3000)); await fetchWlStatus(); }
      if(wlStatus&&wlStatus.connected){
        toast(t('wl_connected'));
        // el servidor lanza la comprobación de listas solo al conectar; espera a que acabe
        toast(t('wl_checking'), 120000);
        for(let i=0;i<60;i++){ await new Promise(x=>setTimeout(x,3000)); await fetchWlStatus(); if(wlStatus && !wlStatus.eligRunning && wlStatus.eligDoneAt) break; }
        await reload(); toast(t('wl_checked'));
      }
      else toast(t('wl_timeout'), 12000);
    }
  }catch(err){ toast('⚠️ '+err.message); }
  b.disabled=false;
});

const STR = {
 es:{tab_radar:'Radar',tab_keys:'Llaves',tab_buy:'Comprar',tab_floors:'Floors',tab_spots:'Plazas',
  h_now:'Minteando ahora / fase abierta',h_soon:'Próximas 72 h',
  hide_low:'ocultar sin señal (sin X y hype 0)',
  only_keys:'solo mis llaves y plazas',
  h_spots:'Mis plazas confirmadas',
  note_spots:'Local y privado: se guarda solo en este navegador, igual que los checkboxes de llaves. Apunta los proyectos donde ya tienes plaza para una fase (GTD, FCFS, WL, PUBLIC…) y cuántas. Puedes añadir un proyecto aunque todavía no tenga fecha de mint: queda como «pendiente» y, en cuanto aparezca en el radar con ese mismo nombre, se asigna solo y te aviso. Si sale con otro nombre, asígnalo a mano en la columna Estado. El Radar marca los mints con plaza con 🎟️ y resalta la fila.',
  spot_add:'Añadir',spot_lbl:'PLAZA',
  sp_empty:'Aún no has apuntado ninguna plaza.',
  sp_name_ph:'Proyecto…',sp_phase_ph:'Fase (GTD, FCFS…)',
  c_sp_phase:'Fase',c_sp_qty:'Cantidad',
  sp_status:'Estado',sp_phases_col:'Fases (cantidad)',
  sp_live:'en el radar · minteando',sp_soon:'en el radar · próximo',
  sp_nodate:'sin fecha de mint — pendiente',
  sp_assign:'— asignar a un mint —',
  sp_note_ph:'nota (dónde/cómo la conseguiste…)',
  sp_added_pending:'Plaza guardada como PENDIENTE: ese proyecto aún no está en el radar. Cuando tenga fecha te aviso; si sale con otro nombre, asígnalo desde la columna Estado.',
  sp_now_live:'🎟️ ¡Ya hay fecha! {p} está en el radar y tienes plaza.',
  sp_pending_count:'🎟️ {n} plaza(s) pendientes (proyecto sin fecha de mint todavía).',
  sp_del_project:'borrar el proyecto y todas sus plazas',
  wl_os:'OpenSea:',
  wl_none_lists:'no estás en ninguna lista (comprobado)',
  wl_os_tip:'Elegibilidad real de tu wallet en OpenSea (firmada por su servidor). ✅ = estás en la lista de esa fase.',
  wl_count:'wallets en esta lista de OpenSea',
  wl_conn:'OpenSea',wl_connect:'Conectar OpenSea',wl_reconnect:'Reconectar',
  wl_refresh:'Actualizar elegibilidad',
  wl_expires:'caduca',wl_expired:'sesión caducada',
  wl_connecting:'Abriendo OpenSea… aprueba el permiso en la pestaña nueva.',
  wl_connected:'✅ OpenSea conectado',
  wl_checking:'Comprobando tus listas en OpenSea…',
  wl_checked:'Elegibilidad actualizada ✓',
  wl_need_cli:'Necesita el CLI de OpenSea. En una terminal:  npm i -g @opensea/cli  ·  luego  opensea login --scopes read:eligibility',
  wl_no_url:'No pude arrancar el login. Abre una terminal en la carpeta y ejecuta:  npx -y @opensea/cli@2 login --scopes read:eligibility',
  wl_popup:'Tu navegador bloqueó la ventana. Abre esta URL a mano:',
  wl_timeout:'Sigo sin ver la sesión. Cuando termines en OpenSea pulsa "Actualizar elegibilidad".',
  wl_server_only:'La conexión con OpenSea solo funciona en modo servidor (servidor.cmd). En el fichero suelto: abre una terminal y ejecuta  opensea login --scopes read:eligibility',
  tab_wallet:'Cartera',
  h_wallet:'Cartera / P&L — compras y ventas de tus wallets',
  w_real_only:'solo con P&L real (oculta coste desconocido)',
  w_hide_held:'ocultar lo que sigo teniendo',
  w_note:'Reconstruido de la API de OpenSea. NO incluye gas · los mints cuentan como coste 0 · P&L en ETH y $ al cambio de hoy (no histórico) · ventas fuera de OpenSea (Blur…) salen como «movido» sin precio. data/trades.json es personal (fuera de git y del modo público). Actualízalo con  node scripts/fetch-trades.mjs  (o update.mjs).',
  w_realized:'Realizado',w_unrealized:'No realizado',w_sold:'Vendidos',w_held:'En cartera',w_moved:'Movidos fuera',
  w_none:'Sin datos de cartera. Ejecuta  node scripts/fetch-trades.mjs  (necesita wallets.json + OPENSEA_API_KEY).',
  w_truncated:'⚠️ historial largo: puede faltar lo más antiguo.',
  c_bought:'Comprado',c_soldfloor:'Vendido / Floor',c_pnl:'P&L',c_state:'Estado',
  st_held:'en cartera',st_sold:'vendido',st_moved:'movido fuera',
  ty_mint:'mint',ty_buy:'compra',ty_transfer_in:'recibido',ty_sale:'venta',ty_transfer_out:'enviado',
  hdr_show:'mostrar filtros',hdr_hide:'ocultar filtros',
  sched_os:'agenda oficial de OpenSea (SeaDrop) — sustituye a la del feed',
  all_chains:'Todas',
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
  sys_update:'se actualiza solo cada 10 min',
  refresh:'Actualizar',saved:'Guardado en colecciones.json',refreshing:'Actualizando…',updated_ok:'Datos actualizados ✓',
  rate_tip:'Estimación /15 min a partir del ritmo de 2 h de NFT Trencher (÷8). Se vuelve exacto (sin ~) cuando el monitor lleva ≥15 min en marcha con serve.mjs.',
  rate_tip15:'Ritmo real: minteados en los últimos ~15 min (calculado por el monitor con datos de OpenSea)',
  no_market:'sin mercado',thin_market:'mercado mínimo',closes:'cierra',
  limit_tip:'NFTs máximos por wallet en esta fase',two_src:'confirmado en 2 fuentes',
  owners_tip:'Wallets únicas que poseen algún NFT, y qué % son del total minteado. Cerca del 100% = muy repartido. Bajo = pocas wallets acumulan muchos (🐳 si <45%).',
  fee_tip:'Creator fee / royalty: % que se lleva el proyecto en cada reventa',
  fee_lbl:'💸 royalty',
  vol_tip:'Volumen de ventas en las últimas 24 h (moneda del floor)',
  alert_tip:'Avisarme ~10 min antes de un cambio de fase — elige qué fase (deja la pestaña abierta)',
  alert_set:'🔔 Alerta activada. Te avisaré ~10 min antes. Deja esta pestaña abierta.',
  alert_set_toast:'🔔 Alerta activada (aviso en la propia página; las notificaciones del navegador están bloqueadas).',
  alert_off:'🔕 Alerta quitada',
  alert_clear_all:'descartar todo',
  alert_body:'cambio de fase en ~{m} min',
  alert_body_ph:'fase {p} en ~{m} min',
  search_ph:'Buscar… (nombre, fase, llave, nota…)',
  alert_pick:'¿De qué fase te aviso?',alert_any:'cualquier cambio de fase',
  legend:'Fases: <b class="ph-GTD">GTD</b> plaza garantizada · <b class="ph-FCFS">FCFS</b> por orden de llegada · <b class="ph-WL">WL/Holder</b> lista genérica · <b>TEAM/PUBLIC</b> equipo / abierto a todos.  <b>●</b> = abierta ahora · <s>tachada</s> = terminada · <b>×N</b> = NFTs por wallet',
  help:'<h3>Cómo leer Monitor MINTS</h3>'+
   '<p>Seguimiento en vivo de los mints de Robinhood Chain. Se actualiza solo cada 10 min. Lo que marques se guarda solo en tu navegador. El buscador de arriba filtra las filas por cualquier texto (nombre, fase, llave, nota…); la casilla <b>solo mis llaves</b> deja únicamente los mints para los que tienes llave (marca tus llaves en la pestaña Llaves). Pulsa una cabecera de columna para ordenar.</p>'+
   '<h4>Una fila del Radar</h4><ul>'+
   '<li><b>Proyecto</b> — nombre + enlaces (X / web / OpenSea). <code>live</code> = minteando ahora, <code>SOON</code> = en menos de 72 h, <b>✓✓</b> = confirmado en 2 fuentes.</li>'+
   '<li><b>Minteado</b> — <code>373 / 4.4K</code> = minteados / supply total. <b>⚡ +N/15m</b> = ritmo en los últimos 15 min (<code>~</code> = estimación). <b>👤 294 (79%)</b> = wallets únicas con algún NFT y su % sobre lo minteado: verde ≥70% repartido, ámbar 45–70%, rojo + 🐳 por debajo de 45% = pocas wallets acumulan.</li>'+
   '<li><b>Hype / Popularidad / Actividad X</b> — hype del feed, lectura ALTA/MEDIA/BAJA de la cuenta de X, y los números en crudo: seguidores · posts · antigüedad. Antigüedad marcada = cuenta con menos de 30 días.</li>'+
   '<li><b>Fases</b> — una pastilla por fase con su precio. <b class="ph-GTD">GTD</b> plaza garantizada · <b class="ph-FCFS">FCFS</b> por orden de llegada · <b class="ph-WL">WL/Holder</b> lista genérica · <b>TEAM/PUBLIC</b> equipo / abierto a todos. <b>●</b> abierta ahora · <s>tachada</s> terminada · <code>×N</code> máximo de NFTs por wallet.</li>'+
   '<li><b>Llaves</b> — qué colecciones te dan acceso a ese mint. <b>⭐ TIENES LLAVE</b> si posees una; <i>elegibilidad sin investigar</i> = aún sin averiguar (las listas se anuncian en X/Discord).</li>'+
   '<li><b>Precio public</b> — precio de mint público ($ + ETH). <b>💸 royalty X%</b> = comisión del creador en cada reventa.</li>'+
   '<li><b>Floor</b> — floor del mercado secundario. <code>· 2.8×</code> = floor frente al precio de mint (verde sube / rojo baja); <code>FREE→$X</code> en mints gratis; <i>sin mercado / mercado mínimo</i> cuando hay pocas ventas.</li>'+
   '<li><b>Cuándo</b> — cuenta atrás + hora exacta (UTC y tu hora local). Pulsa <b>🔕/🔔</b> y elige la fase (p.ej. solo PUBLIC): ~10 min antes de ese cambio salta un <b>banner rojo arriba + pitido</b> (y notificación del sistema si la permites). Solo con la pestaña abierta.</li>'+
   '</ul><h4>Otras pestañas</h4><ul>'+
   '<li><b>🔑 Llaves</b> — todas las colecciones llave ordenadas por utilidad WL frente al precio. <code>wl_value</code> criterio editorial 0–10 · <code>util</code> GTD/FCFS/WL ponderado del registro de mints · <code>ce</code> = util ÷ floor (alto = infravalorada). Marca aquí lo que tienes.</li>'+
   '<li><b>🛒 Comprar</b> — lista corta de llaves top que aún no tienes, por prioridad y wl_value.</li>'+
   '<li><b>📉 Floors</b> — llaves cuyo floor se movió ±15% en 7 días. <b>🛒</b> marca una caída fuerte en una llave prioritaria.</li>'+
   '<li><b>🎟️ Plazas</b> — apunta a mano los proyectos donde ya tienes plaza confirmada (GTD/FCFS/WL/PUBLIC…) y cuántas. Es local a tu navegador. Puedes añadir un proyecto aunque aún no tenga fecha de mint: queda <i>pendiente</i> y, cuando aparezca en el radar con ese nombre, se asigna solo y te aviso (si sale con otro nombre lo asignas a mano). El Radar marca esos mints con <b>🎟️</b> y resalta la fila con borde dorado.</li>'+
   '</ul>'},
 en:{tab_radar:'Radar',tab_keys:'Keys',tab_buy:'Buy',tab_floors:'Floors',tab_spots:'Spots',
  h_now:'Minting now / open phase',h_soon:'Next 72 h',
  hide_low:'hide no-signal (no X, hype 0)',
  only_keys:'only my keys & spots',
  h_spots:'My confirmed spots',
  note_spots:'Local and private: saved in this browser only, just like the key checkboxes. Note the projects where you already hold a spot for a phase (GTD, FCFS, WL, PUBLIC…) and how many. You can add a project even if it has no mint date yet: it stays "pending" and, as soon as it shows up in the radar under the same name, it is assigned automatically and you get a heads-up. If it appears under a different name, assign it by hand in the Status column. The Radar flags mints with a spot with 🎟️ and highlights the row.',
  spot_add:'Add',spot_lbl:'SPOT',
  sp_empty:'No spots noted yet.',
  sp_name_ph:'Project…',sp_phase_ph:'Phase (GTD, FCFS…)',
  c_sp_phase:'Phase',c_sp_qty:'Qty',
  sp_status:'Status',sp_phases_col:'Phases (qty)',
  sp_live:'in radar · minting',sp_soon:'in radar · soon',
  sp_nodate:'no mint date — pending',
  sp_assign:'— assign to a mint —',
  sp_note_ph:'note (where/how you got it…)',
  sp_added_pending:'Spot saved as PENDING: that project is not in the radar yet. You will get a heads-up when it gets a date; if it shows under a different name, assign it from the Status column.',
  sp_now_live:'🎟️ It has a date now! {p} is in the radar and you hold a spot.',
  sp_pending_count:'🎟️ {n} pending spot(s) (project has no mint date yet).',
  sp_del_project:'delete the project and all its spots',
  wl_os:'OpenSea:',
  wl_none_lists:'not on any list (checked)',
  wl_os_tip:'Your wallet’s real eligibility on OpenSea (signed by their server). ✅ = you are on that stage’s list.',
  wl_count:'wallets on this OpenSea list',
  wl_conn:'OpenSea',wl_connect:'Connect OpenSea',wl_reconnect:'Reconnect',
  wl_refresh:'Refresh eligibility',
  wl_expires:'expires',wl_expired:'session expired',
  wl_connecting:'Opening OpenSea… approve the grant in the new tab.',
  wl_connected:'✅ OpenSea connected',
  wl_checking:'Checking your OpenSea lists…',
  wl_checked:'Eligibility refreshed ✓',
  wl_need_cli:'Needs the OpenSea CLI. In a terminal:  npm i -g @opensea/cli  ·  then  opensea login --scopes read:eligibility',
  wl_no_url:'Could not start the login. Open a terminal in the folder and run:  npx -y @opensea/cli@2 login --scopes read:eligibility',
  wl_popup:'Your browser blocked the popup. Open this URL manually:',
  wl_timeout:'Still no session. When you finish on OpenSea, press "Refresh eligibility".',
  wl_server_only:'Connecting OpenSea only works in server mode (servidor.cmd). For the standalone file: open a terminal and run  opensea login --scopes read:eligibility',
  tab_wallet:'Portfolio',
  h_wallet:'Portfolio / P&L — your wallets’ buys and sells',
  w_real_only:'only with real P&L (hide unknown cost)',
  w_hide_held:'hide what I still hold',
  w_note:'Reconstructed from the OpenSea API. Does NOT include gas · mints count as cost 0 · P&L in ETH and $ at today’s rate (not historical) · sales outside OpenSea (Blur…) show as “moved” with no price. data/trades.json is personal (out of git and of public mode). Refresh with  node scripts/fetch-trades.mjs  (or update.mjs).',
  w_realized:'Realized',w_unrealized:'Unrealized',w_sold:'Sold',w_held:'Held',w_moved:'Moved out',
  w_none:'No portfolio data. Run  node scripts/fetch-trades.mjs  (needs wallets.json + OPENSEA_API_KEY).',
  w_truncated:'⚠️ long history: the oldest items may be missing.',
  c_bought:'Bought',c_soldfloor:'Sold / Floor',c_pnl:'P&L',c_state:'Status',
  st_held:'held',st_sold:'sold',st_moved:'moved out',
  ty_mint:'mint',ty_buy:'buy',ty_transfer_in:'received',ty_sale:'sale',ty_transfer_out:'sent',
  hdr_show:'show filters',hdr_hide:'hide filters',
  sched_os:'official OpenSea drop schedule (SeaDrop) — overrides the feed',
  all_chains:'All',
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
  sys_update:'auto-updates every 10 min',
  refresh:'Refresh',saved:'Saved to colecciones.json',refreshing:'Refreshing…',updated_ok:'Data updated ✓',
  rate_tip:'/15 min estimate from NFT Trencher 2 h rate (÷8). Becomes exact (no ~) once the monitor has run ≥15 min with serve.mjs.',
  rate_tip15:'Real rate: minted in the last ~15 min (computed by the monitor from OpenSea data)',
  no_market:'no market',thin_market:'thin market',closes:'closes',
  limit_tip:'Max NFTs per wallet in this phase',two_src:'confirmed by 2 sources',
  owners_tip:'Unique wallets holding at least one NFT, and what % of total minted that is. Near 100% = well spread. Low = few wallets hoarding many (🐳 if <45%).',
  fee_tip:'Creator fee / royalty: % the project takes on every resale',
  fee_lbl:'💸 royalty',
  vol_tip:'Sales volume in the last 24 h (floor currency)',
  alert_tip:'Alert me ~10 min before a phase change — pick which phase (keep this tab open)',
  alert_set:'🔔 Alert on. I will warn you ~10 min before. Keep this tab open.',
  alert_set_toast:'🔔 Alert on (in-page only; browser notifications are blocked).',
  alert_off:'🔕 Alert removed',
  alert_clear_all:'dismiss all',
  alert_body:'phase change in ~{m} min',
  alert_body_ph:'{p} phase in ~{m} min',
  search_ph:'Search… (name, phase, key, note…)',
  alert_pick:'Which phase should I alert on?',alert_any:'any phase change',
  legend:'Phases: <b class="ph-GTD">GTD</b> guaranteed spot · <b class="ph-FCFS">FCFS</b> first come first served · <b class="ph-WL">WL/Holder</b> generic list · <b>TEAM/PUBLIC</b> team / open to all.  <b>●</b> = open now · <s>struck</s> = ended · <b>×N</b> = NFTs per wallet',
  help:'<h3>How to read Monitor MINTS</h3>'+
   '<p>Live tracker for Robinhood Chain mints. Auto-updates every 10 min. Anything you tick is saved only in your browser. The search box up top filters rows by any text (name, phase, key, note…); the <b>only my keys</b> checkbox keeps only mints you hold a key for (tick your keys in the Keys tab). Click a column header to sort.</p>'+
   '<h4>A Radar row</h4><ul>'+
   '<li><b>Project</b> — name + links (X / site / OpenSea). <code>live</code> = minting now, <code>SOON</code> = within 72 h, <b>✓✓</b> = confirmed by 2 sources.</li>'+
   '<li><b>Minted</b> — <code>373 / 4.4K</code> = minted / total supply. <b>⚡ +N/15m</b> = mint rate in the last 15 min (<code>~</code> = estimate). <b>👤 294 (79%)</b> = unique holder wallets and their share of minted: green ≥70% spread, amber 45–70%, red + 🐳 under 45% = few wallets hoarding.</li>'+
   '<li><b>Hype / Popularity / X activity</b> — feed hype score, a HIGH/MED/LOW read of the X account, and raw followers · posts · account age. A flagged age = account under 30 days old.</li>'+
   '<li><b>Phases</b> — one pill per phase with its price. <b class="ph-GTD">GTD</b> guaranteed spot · <b class="ph-FCFS">FCFS</b> first come first served · <b class="ph-WL">WL/Holder</b> generic list · <b>TEAM/PUBLIC</b> team / open to all. <b>●</b> open now · <s>struck</s> ended · <code>×N</code> max NFTs per wallet.</li>'+
   '<li><b>Keys</b> — which collections make you eligible for that mint. <b>⭐ YOU HAVE A KEY</b> if you own one; <i>eligibility not researched</i> = not figured out yet (allowlists are announced on X/Discord).</li>'+
   '<li><b>Public price</b> — public mint price ($ + ETH). <b>💸 royalty X%</b> = creator fee taken on every resale.</li>'+
   '<li><b>Floor</b> — secondary-market floor. <code>· 2.8×</code> = floor vs mint price (green up / red down); <code>FREE→$X</code> for free mints; <i>no / thin market</i> when sales are too few to trust.</li>'+
   '<li><b>When</b> — countdown + exact time (UTC and your local time). Click <b>🔕/🔔</b> and pick a phase (e.g. PUBLIC only): ~10 min before that change you get a <b>red banner on top + a beep</b> (plus a system notification if you allow it). Only while the tab is open.</li>'+
   '</ul><h4>Other tabs</h4><ul>'+
   '<li><b>🔑 Keys</b> — every key collection ranked by WL utility vs price. <code>wl_value</code> editorial 0–10 · <code>util</code> weighted GTD/FCFS/WL from the mint log · <code>ce</code> = util ÷ floor (high = underpriced). Tick what you own here.</li>'+
   '<li><b>🛒 Buy</b> — shortlist of top-tier keys you do not own yet, by priority and wl_value.</li>'+
   '<li><b>📉 Floors</b> — keys whose floor moved ±15% over 7 days. <b>🛒</b> marks a big drop on a high-priority key.</li>'+
   '<li><b>🎟️ Spots</b> — manually note the projects where you already hold a confirmed spot (GTD/FCFS/WL/PUBLIC…) and how many. Local to your browser. You can add a project with no mint date yet: it stays <i>pending</i> and, once it shows in the radar under that name, it is assigned automatically and you get a heads-up (assign it by hand if the name differs). The Radar flags those mints with <b>🎟️</b> and highlights the row with a gold border.</li>'+
   '</ul>'}
};
let L = localStorage.getItem('mints_lang') || (navigator.language||'es').slice(0,2);
if(!STR[L]) L='es';
const t = k => (STR[L][k] ?? k);
let chainSel = localStorage.getItem('mints_chain') || 'robinhood';
const chainLabel = id => { const c=(D.chains||[]).find(x=>x.id===(id||'robinhood')); return c?c.label:null; };
const chainPill = id => { if((D.chains||[]).length<2) return ''; const l=chainLabel(id); return l?'<span class="chpill">'+esc(l)+'</span> ':''; };

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
// enlace a OpenSea para las filas de Llaves / Comprar / Floors
const osA = url => url ? ' <a href="'+url+'" target="_blank" rel="noopener" class="oslink" title="Ver en OpenSea">OpenSea ↗</a>' : '';
const rankOs = name => { const c = D.ranking.find(x=>norm(x.name)===norm(name)); return c ? c.opensea : null; };
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
  // nombre real de la fase (como en OpenSea) si aporta algo sobre el tipo
  const nm = x.n && x.n.trim();
  const label = !nm ? x.k
    : new RegExp(x.k,'i').test(nm.replace(/\\s+/g,'')) ? esc(nm)
    : '<b>'+x.k+'</b> · '+esc(nm);
  return '<span class="phwrap"><span class="pill ph-'+x.k+st+'" title="'+x.k+(x.s?' — '+x.s:'')+'">'+dot+label+' '+(e==null?esc(x.p):money(e))+lim+'</span>'+sub+'</span>';
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

// elegibilidad real de tu wallet (OpenSea): ✅ estás en la lista de esa fase
function wlEligCell(m){
  const w = m.wlElig; if(!w || !w.stages || !w.stages.length) return '';
  // por tipo de fase (WL/GTD/FCFS/HOLDER/TEAM), el mejor estado
  const byK = {};
  for(const s of w.stages){
    if(s.k==='PUBLIC') continue;
    const rank = s.eligible===true?2:s.eligible===false?1:0;
    if(!byK[s.k] || rank>byK[s.k].rank) byK[s.k]={rank, eligible:s.eligible};
  }
  const yes = Object.keys(byK).filter(k=>byK[k].eligible===true);
  if(!yes.length) return '';   // solo interesa cuando SÍ estás en alguna lista
  return '<div class="wl-elig wl-elig-yes" title="'+t('wl_os_tip')+'">🔎 '+t('wl_os')+' '+
    yes.map(k=>'<span class="pill wl-in">✅ '+esc(k)+'</span>').join(' ')+'</div>';
}
const wlEligYes = m => !!(m.wlElig && m.wlElig.stages.some(s=>s.eligible===true && s.k!=='PUBLIC'));
function needCell(m){
  const spot = spotBadge(m);
  const wl = wlEligCell(m);
  const need = (m.need||[]).map(n=>({name:n.name, owned: isOwned(n.name), wallets: n.wallets||[]}));
  if(!need.length) return wl + spot + (wl||spot?'':'<span class="muted" style="font-size:11px">'+t('need_unknown')+'</span>');
  const have = need.some(n=>n.owned);
  return wl + spot + (have?'<div class="have-key">⭐ '+t('have_key')+'</div>':'')
    + need.map(n=>{
        const w = n.wallets.length ? '<span class="wchip" title="'+t('in_wallet')+'">'+n.wallets.map(esc).join('/')+'</span>' : '';
        return '<span class="pill '+(n.owned?'k-own':'')+'">'+(n.owned?'✅ ':'')+esc(n.name)+w+'</span>';
      }).join(' ');
}

// ---- alertas por fila (solo mientras la pestaña esté abierta) ----
// armed: Map  nombreNorm -> filtro de fase  ('*' = cualquier cambio, o 'GTD'/'FCFS'/'WL'/'HOLDER'/'PUBLIC'/'TEAM')
const ALERT_LEAD = 10*60000;               // avisa 10 min antes
const aKey = name => norm(name);
let armed = new Map(); let firedAt = {};
try{
  const raw = JSON.parse(localStorage.getItem('mints_alerts')||'[]');
  for(const it of raw) Array.isArray(it) ? armed.set(it[0], it[1]||'*') : armed.set(it, '*'); // migra formato viejo
}catch(e){}
try{ firedAt = JSON.parse(localStorage.getItem('mints_alerts_fired')||'{}'); }catch(e){}
const saveArmed = () => { try{ localStorage.setItem('mints_alerts', JSON.stringify([...armed])); }catch(e){} };
function saveFired(){
  const cut=Date.now()-2*864e5;
  for(const k in firedAt){ if(firedAt[k]<cut) delete firedAt[k]; }
  try{ localStorage.setItem('mints_alerts_fired', JSON.stringify(firedAt)); }catch(e){}
}
const isArmed = m => armed.has(aKey(m.name));
const armedFilter = m => armed.get(aKey(m.name)) || '*';
// fases futuras de un mint que pasan el filtro -> [{ts, k}]
function futureEvents(m, filter='*'){
  const now=Date.now(), out=[];
  for(const p of m.phases||[]){
    if(filter!=='*' && p.k!==filter) continue;
    if(p.a>now) out.push({ts:p.a, k:p.k});
    if(p.e>now) out.push({ts:p.e, k:p.k});
  }
  if(filter==='*' && m.when>now && !out.some(e=>e.ts===m.when)) out.push({ts:m.when, k:null});
  return out.sort((a,b)=>a.ts-b.ts);
}
// tipos de fase con algún evento futuro (para el menú)
const alertableKinds = m => [...new Set((m.phases||[]).filter(p=>p.a>Date.now()||p.e>Date.now()).map(p=>p.k))];
const canAlert = m => alertableKinds(m).length>0 || m.when>Date.now();

async function armAlert(name, filter){
  unlockAudio();
  if('Notification' in window && Notification.permission==='default'){
    try{ await Notification.requestPermission(); }catch(e){}
  }
  armed.set(aKey(name), filter); saveArmed(); render();
  toast(('Notification' in window && Notification.permission==='denied') ? t('alert_set_toast') : t('alert_set'));
}
function disarmAlert(name){ armed.delete(aKey(name)); saveArmed(); render(); toast(t('alert_off')); }

// quita alertas armadas cuyo mint ya no tiene ningún cambio de fase futuro
function pruneArmed(){
  let changed=false;
  for(const key of [...armed.keys()]){
    const m = D.mints.find(x=>aKey(x.name)===key);
    if(m && !futureEvents(m,'*').length){ armed.delete(key); changed=true; }
  }
  if(changed) saveArmed();
  return changed;
}

function checkAlerts(){
  pruneArmed();
  const now=Date.now();
  for(const m of D.mints){
    if(!isArmed(m)) continue;
    for(const ev of futureEvents(m, armedFilter(m))){
      const key=aKey(m.name)+'|'+ev.ts;
      if(firedAt[key]) continue;
      if(now>=ev.ts-ALERT_LEAD && now<ev.ts){ firedAt[key]=now; saveFired(); fireAlert(m,ev); }
    }
  }
}
// ---- cola de avisos disparados y sin descartar (persiste al recargar) ----
let alertQ = [];
try{ alertQ = JSON.parse(localStorage.getItem('mints_alerts_pending')||'[]'); }catch(e){}
const saveQ = () => { try{ localStorage.setItem('mints_alerts_pending', JSON.stringify(alertQ)); }catch(e){} };
// título según la red seleccionada
function chainName(id){ const c=(D.chains||[]).find(x=>x.id===id); return c ? (c.name||c.label) : null; }
function baseTitle(){
  const n = chainSel==='all' ? null : chainName(chainSel);
  return n ? 'Monitor MINTS — '+n : 'Monitor MINTS';
}

// pitido corto (Web Audio, sin fichero). Se "desbloquea" con un gesto del usuario.
let actx = null;
function unlockAudio(){ try{ actx = actx || new (window.AudioContext||window.webkitAudioContext)(); if(actx.state==='suspended') actx.resume(); }catch(e){} }
function beep(){
  if(!actx) return;
  try{
    const t0=actx.currentTime;
    [[0,740],[0.16,988],[0.32,740]].forEach(([off,f])=>{
      const o=actx.createOscillator(), g=actx.createGain();
      o.type='sine'; o.frequency.value=f;
      g.gain.setValueAtTime(0.0001,t0+off);
      g.gain.exponentialRampToValueAtTime(0.3,t0+off+0.02);
      g.gain.exponentialRampToValueAtTime(0.0001,t0+off+0.14);
      o.connect(g); g.connect(actx.destination);
      o.start(t0+off); o.stop(t0+off+0.15);
    });
  }catch(e){}
}
const favEl = document.getElementById('fav');
const FAV_DEFAULT = favEl ? favEl.getAttribute('href') : null;
function setBadge(){
  const n = alertQ.length;
  const bt = baseTitle();
  document.title = n ? '🔔('+n+') '+bt : bt;
  const h1 = document.getElementById('h1'); if(h1) h1.textContent = '🚨 '+bt;
  if(!favEl) return;
  if(!n){ favEl.href = FAV_DEFAULT; return; }
  try{
    const c=document.createElement('canvas'); c.width=c.height=32; const x=c.getContext('2d');
    x.fillStyle='#ff3b30'; x.beginPath(); x.arc(16,16,15,0,7); x.fill();
    x.fillStyle='#fff'; x.font='bold 24px system-ui'; x.textAlign='center'; x.textBaseline='middle'; x.fillText('!',16,18);
    favEl.href=c.toDataURL('image/png');
  }catch(e){}
}
function evText(a){
  const mins=Math.round((a.ts-Date.now())/60000);
  const es = L==='es';
  const what = a.k ? (es?'fase '+a.k:a.k+' phase') : (es?'cambio de fase':'phase change');
  const when = mins<=0 ? (es?'ahora':'now') : (es?'en ~'+mins+' min':'in ~'+mins+' min');
  return a.name+' — '+what+' '+when;
}
function renderAlertBanner(){
  const now=Date.now();
  // fuera avisos viejos: >2 h desde que saltó, o la fase ya pasó hace >30 min
  alertQ = alertQ.filter(a=>now-a.at < 2*3600e3 && a.ts > now - 30*60000);
  saveQ();
  const el=document.getElementById('alertBanner');
  if(!alertQ.length){ el.hidden=true; setBadge(); return; }
  el.hidden=false;
  el.innerHTML =
    alertQ.map((a,i)=>'<div class="ab-row"><span>🔔 '+esc(evText(a))+'</span><button data-abi="'+i+'">✕</button></div>').join('')
    + (alertQ.length>1 ? '<button class="ab-all" data-abi="all">'+t('alert_clear_all')+'</button>' : '');
  setBadge();
}
function fireAlert(m,ev){
  const msg = evText({name:m.name, k:ev.k, ts:ev.ts});
  if('Notification' in window && Notification.permission==='granted'){
    try{ new Notification('🚨 Monitor MINTS', { body: msg, requireInteraction:true, tag:aKey(m.name)+ev.ts }); }catch(e){}
  }
  alertQ.push({ name:m.name, k:ev.k, ts:ev.ts, at:Date.now() });
  saveQ(); renderAlertBanner(); beep();
  toast('🔔 '+msg, 12000);
}
function bellBtn(m){
  if(!canAlert(m)) return '';
  const on=isArmed(m), f=on?armedFilter(m):null;
  const tag = on && f!=='*' ? '<sub style="font-size:8px">'+esc(f)+'</sub>' : '';
  return '<button class="bell'+(on?' on':'')+'" data-alert="'+esc(m.name)+'" title="'+t('alert_tip')+'">'+(on?'🔔':'🔕')+tag+'</button> ';
}
// menú flotante para elegir la fase de la alerta
function openAlertMenu(name, x, y){
  closeAlertMenu();
  const m = D.mints.find(mm=>aKey(mm.name)===aKey(name)); if(!m) return;
  const on = armed.has(aKey(name));
  const rows = [];
  if(on) rows.push('<button data-f="__off">✕ '+t('alert_off').replace('🔕 ','')+'</button>');
  rows.push('<button data-f="*">🔔 '+t('alert_any')+'</button>');
  for(const k of alertableKinds(m)) rows.push('<button data-f="'+esc(k)+'"'+(on&&armedFilter(m)===k?' class="sel"':'')+'>'+esc(k)+'</button>');
  const el = document.createElement('div');
  el.id='alertMenu'; el.dataset.name=name;
  el.innerHTML = '<div class="am-h">'+t('alert_pick')+'</div>'+rows.join('');
  document.body.appendChild(el);
  const w=el.offsetWidth, h=el.offsetHeight;
  el.style.left = Math.max(6, Math.min(x, innerWidth-w-6))+'px';
  el.style.top  = Math.max(6, Math.min(y, innerHeight-h-6))+'px';
}
function closeAlertMenu(){ const e=document.getElementById('alertMenu'); if(e) e.remove(); }

const cell = (label,html,cls,sort) => '<td'+(cls?' class="'+cls+'"':'')+' data-label="'+esc(label)+'"'+(sort!=null?' data-sort="'+esc(sort)+'"':'')+'>'+html+'</td>';
// rango para ordenar la columna Llaves: +8 estoy en la lista (OpenSea) · +4 tengo plaza · +2 tengo llave · +1 elegibilidad conocida
const keyRank = m => {
  let r = 0;
  if(wlEligYes(m)) r += 8;
  if(spotFor(m.name)) r += 4;
  const nd = m.need||[];
  if(nd.some(n=>isOwned(n.name))) r += 2; else if(nd.length) r += 1;
  return r;
};
const haveKeyRow = m => (m.need||[]).some(n=>isOwned(n.name)) || wlEligYes(m);
function mintRows(list){
  if(!list.length) return '';
  return list.map(m=>{
   const rc = [haveKeyRow(m)?'row-have':'', spotFor(m.name)?'row-spot':''].filter(Boolean).join(' ');
   return '<tr'+(rc?' class="'+rc+'"':'')+'>'+
    cell('', chainPill(m.chain)+'<b>'+esc(m.name)+'</b> '+(m.status==='now'?'<span class="badge b-now">'+t('now')+'</span>':'')+(m.srcs===2?' <span class="v2" title="'+t('two_src')+'">✓✓</span>':'')+'<br><span class="muted" style="font-size:12px">'+links(m)+'</span>', null, esc(m.name).toLowerCase())+
    cell(t('c_supply'), nf(m.minted)+' / '+nf(m.supply)+rateCell(m)+ownersCell(m), 'num', m.minted||0)+
    cell(t('c_hype'), m.hype, 'num', m.hype||0)+
    cell(t('c_pop'), popTxt(m))+
    cell(t('c_x'), xCell(m), null, m.xFollowers||0)+
    cell(t('c_phases'), (phases(m.phases)||'<span class="muted">—</span>')+(m.schedSrc==='opensea'?' <span class="phwhen" title="'+t('sched_os')+'">· OpenSea</span>':''))+
    cell(t('c_keys'), needCell(m), null, keyRank(m))+
    cell(t('c_price'), money(publicPrice(m))+feeCell(m), 'num', publicPrice(m)??-1)+
    cell(t('c_floor'), floorRadar(m), 'num', m.floorUsd??-1)+
    cell(t('c_when'), bellBtn(m)+whenCell(m.when), 'num', m.when||9e15)+
  '</tr>';
  }).join('');
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

// filtro de texto (subcadena, sin acentos) sobre cualquier texto de la fila
const sNorm = s => String(s).toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g,'');
function applyFilter(){
  const q = sNorm((document.getElementById('q').value||'').trim());
  const onlyK = document.getElementById('onlyKeys').checked;
  document.querySelectorAll('section[data-p] table tr').forEach(tr=>{
    if(tr.querySelector('th')) return;
    let show = q ? sNorm(tr.textContent).includes(q) : true;
    if(show && onlyK && tr.closest('section').dataset.p==='radar') show = tr.classList.contains('row-have') || tr.classList.contains('row-spot');
    tr.hidden = !show;
  });
}

// ---- Cartera / P&L ----
function ethShort(v){ if(v==null) return '—'; const a=Math.abs(v), s=v<0?'-':''; return a>=0.01 ? s+'Ξ'+a.toFixed(3) : s+(a*1000).toFixed(1)+'mΞ'; }
const pnlCls = v => v>0?'pnl-pos':v<0?'pnl-neg':'';
function renderWallet(){
  const box=document.getElementById('wStats'), tbl=document.getElementById('tWallet');
  if(!box||!tbl) return;
  const T=D.trades;
  if(!T){ box.innerHTML=''; tbl.innerHTML='<tbody><tr><td class="muted">'+t('w_none')+'</td></tr></tbody>'; return; }
  const s=T.summary;
  const tile=(k,v)=>'<div class="wstat"><div class="k">'+esc(k)+'</div><div class="v">'+v+'</div></div>';
  box.innerHTML=
    tile(t('w_realized'), '<span class="'+pnlCls(s.realizedEth)+'">'+ethShort(s.realizedEth)+'</span> <small>'+fmtUsd(s.realizedUsd)+'</small>')+
    tile(t('w_unrealized'), '<span class="'+pnlCls(s.unrealizedEth)+'">'+ethShort(s.unrealizedEth)+'</span>')+
    tile(t('w_sold'), s.sold+' <small>'+s.wins+'✅ / '+s.losses+'❌</small>')+
    tile(t('w_held'), s.held)+
    tile(t('w_moved'), s.movedOut);

  const realOnly=document.getElementById('wRealOnly').checked;
  const hideHeld=document.getElementById('wHeldHide').checked;
  let rows=T.positions.filter(p=>chainSel==='all'||p.chain===chainSel);
  if(hideHeld) rows=rows.filter(p=>p.status!=='held');
  if(realOnly) rows=rows.filter(p=>p.realizedEth!=null || (p.status==='held'&&p.unrealizedEth!=null&&!(p.flags||[]).includes('cost_unknown')));

  const dt=ts=>ts?new Date(ts*1000).toLocaleDateString(L==='es'?'es-ES':'en-US',{year:'2-digit',month:'short',day:'numeric'}):'—';
  const pr=(eth,usd)=>eth==null?'<span class="muted">?</span>':ethShort(eth)+(usd!=null&&Math.abs(usd)>=0.5?' <small class="muted">'+fmtUsd(usd)+'</small>':'');
  const flags=fl=>(fl||[]).map(f=>'<span class="wflag">'+esc(f.replace(/_/g,' '))+'</span>').join('');
  const tyf=k=>t('ty_'+k)===('ty_'+k)?k:t('ty_'+k);

  tbl.innerHTML='<thead><tr><th>'+t('c_project')+'</th><th>'+t('c_bought')+'</th><th>'+t('c_soldfloor')+'</th><th>'+t('c_pnl')+'</th><th>'+t('c_state')+'</th></tr></thead><tbody>'+
   (rows.map(p=>{
     const a=p.acquired, dp=p.disposed;
     const pnl = p.realizedEth!=null ? p.realizedEth : (p.status==='held' ? p.unrealizedEth : null);
     const pnlUsd = p.realizedUsd!=null ? p.realizedUsd : null;
     const pct = (a&&a.priceEth>0&&pnl!=null) ? Math.round(pnl/a.priceEth*100) : null;
     const stTxt = p.status==='held'?t('st_held'):p.status==='sold'?t('st_sold'):t('st_moved');
     return '<tr>'+
       cell(t('c_project'), chainPill(p.chain)+'<b>'+esc(p.name)+'</b>'+(p.url?' '+osA(p.url):'')+(flags(p.flags)?'<br>'+flags(p.flags):''), null, esc(p.name).toLowerCase())+
       cell(t('c_bought'), a?dt(a.ts)+' · '+tyf(a.type)+'<br>'+pr(a.priceEth,a.priceUsd):'—', 'num', a?a.ts:0)+
       cell(t('c_soldfloor'), dp?dt(dp.ts)+' · '+tyf(dp.type)+'<br>'+pr(dp.priceEth,dp.priceUsd):(p.floorEth!=null?'floor '+ethShort(p.floorEth):'—'), 'num', dp?dp.ts:9e14)+
       cell(t('c_pnl'), pnl==null?'<span class="muted">—</span>':'<span class="'+pnlCls(pnl)+'">'+ethShort(pnl)+(pnlUsd!=null&&Math.abs(pnlUsd)>=0.5?' <small>'+fmtUsd(pnlUsd)+'</small>':'')+(pct!=null?' <small>'+(pct>0?'+':'')+pct+'%</small>':'')+'</span>', 'num', pnl==null?-9e9:pnl)+
       cell(t('c_state'), stTxt)+
     '</tr>';
   }).join('') || '<tr><td colspan=5 class="muted">—</td></tr>')+'</tbody>';

  const note=document.querySelector('section[data-p="wallet"] .note');
  if(note && T.truncated) note.textContent = t('w_truncated')+' '+t('w_note');
}

function render(){
  pruneArmed();
  document.documentElement.lang = L;
  document.querySelectorAll('[data-k]').forEach(el=>el.textContent = t(el.dataset.k));
  document.getElementById('q').placeholder = t('search_ph');
  document.getElementById('legend').innerHTML = t('legend');
  document.querySelectorAll('#lang button').forEach(b=>b.classList.toggle('on',b.dataset.l===L));

  // selector de red (solo si hay más de una)
  const chEl=document.getElementById('chains');
  if((D.chains||[]).length>1){
    if(chainSel!=='all' && !D.chains.some(c=>c.id===chainSel)) chainSel = D.chains[0].id;
    chEl.hidden=false;
    chEl.innerHTML='<button data-c="all"'+(chainSel==='all'?' class="on"':'')+'>'+t('all_chains')+'</button>'+
      D.chains.map(c=>'<button data-c="'+c.id+'"'+(chainSel===c.id?' class="on"':'')+'>'+esc(c.label)+'</button>').join('');
  } else chEl.hidden=true;
  const inChain = x => chainSel==='all' || (x.chain||'robinhood')===chainSel;
  const MINTS = D.mints.filter(inChain);
  const RANKING = D.ranking.filter(inChain);
  setBadge();   // título + h1 según la red seleccionada
  const cart = D.holdings
    ? ' · 👛 ' + (D.holdings.keys.length
        ? D.holdings.keys.length + ' ' + t('cartera') + ' (' + D.holdings.wallets.join(', ') + ')'
        : t('cartera_none'))
    : '';
  document.getElementById('upd').textContent =
    (L==='es'?'Actualizado: ':'Updated: ') + new Date(D.updated).toLocaleString(L==='es'?'es-ES':'en-US') +
    ' · ' + MINTS.length + ' mints · ' + RANKING.length + (L==='es'?' colecciones':' collections') + cart +
    (D.public ? ' · ' + t('sys_update') : '');

  const HNOW='<thead><tr><th>'+t('c_project')+'</th><th>'+t('c_supply')+'</th><th>'+t('c_hype')+'</th><th>'+t('c_pop')+
    '</th><th>'+t('c_x')+'</th><th>'+t('c_phases')+'</th><th>'+t('c_keys')+'</th><th>'+t('c_price')+'</th><th>'+t('c_floor')+'</th><th>'+t('c_when')+'</th></tr></thead>';
  const nowL = MINTS.filter(m=>m.status==='now');
  let soonL = MINTS.filter(m=>m.status==='soon');
  if(document.getElementById('hideLow').checked) soonL = soonL.filter(m=>m.x || m.hype>0);
  document.getElementById('tNow').innerHTML = HNOW + '<tbody>' + (mintRows(nowL) || '<tr><td colspan=10 class=muted>'+t('nothing_now')+'</td></tr>') + '</tbody>';
  document.getElementById('tSoon').innerHTML = HNOW + '<tbody>' + (mintRows(soonL) || '<tr><td colspan=10 class=muted>'+t('nothing_soon')+'</td></tr>') + '</tbody>';

  document.getElementById('tKeys').innerHTML =
   '<thead><tr><th>'+t('c_have')+'</th><th>#</th><th>'+t('c_coll')+'</th><th>'+t('c_prio')+'</th><th>'+t('c_tier')+'</th><th>'+t('c_floor')+
   '</th><th>'+t('c_wl')+'</th><th>'+t('c_ev')+'</th><th>util</th><th>ce</th><th>'+t('c_note')+'</th></tr></thead><tbody>'+
   RANKING.map((c,i)=>{const own=isOwned(c.name);return '<tr class="'+(own?'row-have':'')+'">'+
    cell(t('c_have'), '<input type="checkbox" class="ownchk" data-name="'+esc(c.name)+'"'+(own?' checked':'')+'>')+
    cell('#', (i+1), 'num')+
    cell(t('c_coll'), chainPill(c.chain)+esc(c.name)+(own?' ✅':'')+(c.wallets&&c.wallets.length?' <span class="wchip" title="'+t('in_wallet')+'">'+c.wallets.map(esc).join('/')+'</span>':'')+osA(c.opensea), own?'owned':'')+
    cell(t('c_prio'), c.priority)+cell(t('c_tier'), c.tier)+
    cell(t('c_floor'), money(c.floorEth), 'num')+
    cell(t('c_wl'), (c.wlValue??'—'), 'num')+
    cell(t('c_ev'), c.gtd+'/'+c.fcfs+'/'+c.wl, 'num')+
    cell('util', c.util.toFixed(1), 'num')+
    cell('ce', (c.ce==null?'—':Math.round(c.ce)), 'num')+
    cell(t('c_note'), esc(c.notes), 'muted')+
   '</tr>';}).join('')+'</tbody>';

  const order=['🥇','🥈','💎','👑'];
  const buy = RANKING.filter(c=>order.includes(c.priority))
    .sort((a,b)=>(isOwned(a.name)?1:0)-(isOwned(b.name)?1:0)   // las que ya tienes, al final
      || order.indexOf(a.priority)-order.indexOf(b.priority) || (b.wlValue??0)-(a.wlValue??0));
  document.getElementById('tBuy').innerHTML =
   '<thead><tr><th>'+t('c_prio')+'</th><th>'+t('c_coll')+'</th><th>'+t('c_floor')+'</th><th>'+t('c_wl')+'</th><th>'+t('c_note')+'</th></tr></thead><tbody>'+
   buy.map(c=>{const own=isOwned(c.name);return '<tr'+(own?' class="row-have"':'')+'>'+
    cell(t('c_prio'), c.priority)+
    cell(t('c_coll'), chainPill(c.chain)+(own?'<span class="owned">✅ </span>':'')+'<b'+(own?' style="opacity:.55"':'')+'>'+esc(c.name)+'</b>'+(own?' <span class="v2">'+t('have_key')+'</span>':'')+osA(c.opensea))+
    cell(t('c_floor'), money(c.floorEth), 'num')+
    cell(t('c_wl'), (c.wlValue??'—'), 'num')+cell(t('c_note'), esc(c.notes), 'muted')+'</tr>';}).join('')+'</tbody>';

  document.getElementById('tFloors').innerHTML =
   '<thead><tr><th>'+t('c_coll')+'</th><th>'+t('c_prio')+'</th><th>'+t('c_before')+'</th><th>'+t('c_after')+'</th><th>Δ</th></tr></thead><tbody>'+
   (D.alerts.map(a=>'<tr>'+cell(t('c_coll'), esc(a.name)+osA(rankOs(a.name)))+cell(t('c_prio'), a.priority)+
    cell(t('c_before'), money(a.from), 'num')+cell(t('c_after'), money(a.to), 'num')+
    cell('Δ', a.change.toFixed(0)+'%'+(a.change<=-15&&['👑','💎','🥇','🥈'].includes(a.priority)?' 🛒':''), 'num '+(a.change<0?'drop':'rise'))+'</tr>').join('')
    || '<tr><td colspan=5 class=muted>'+t('no_hist')+'</td></tr>')+'</tbody>';

  // ---- Plazas (local) ----
  checkSpotsMatched();
  const allNames=[...new Set((D.mints||[]).map(m=>m.name))].sort((a,b)=>a.localeCompare(b));
  const spNames=document.getElementById('spNames');
  if(spNames) spNames.innerHTML=allNames.map(n=>'<option value="'+esc(n)+'"></option>').join('');
  const spNameEl=document.getElementById('spName'), spPhaseEl=document.getElementById('spPhase');
  if(spNameEl) spNameEl.placeholder=t('sp_name_ph');
  if(spPhaseEl) spPhaseEl.placeholder=t('sp_phase_ph');
  const assignOpts='<option value="">'+esc(t('sp_assign'))+'</option>'+allNames.map(n=>'<option value="'+esc(n)+'">'+esc(n)+'</option>').join('');
  const mintByNorm=new Map((D.mints||[]).map(m=>[norm(m.name), m]));
  let spPend=0;
  const spRows=Object.entries(spotsDB).sort((a,b)=>a[1].name.localeCompare(b[1].name)).map(([k,e])=>{
    const m=mintByNorm.get(k);
    if(!m) spPend++;
    const status=m
      ? '<span class="sp-on">🎯 '+t(m.status==='now'?'sp_live':'sp_soon')+'</span>'
      : '<span class="sp-pend">⏳ '+t('sp_nodate')+'</span>'+
        '<select class="spassign" data-sk="'+esc(k)+'">'+assignOpts+'</select>';
    const phasesHtml=e.phases.slice().sort((x,y)=>x.k.localeCompare(y.k)).map(p=>
      '<div class="spphase"><span class="pill ph-'+esc(p.k)+'">'+esc(p.k)+'</span> × '+
      '<input type="number" min="1" value="'+esc(p.qty)+'" class="spqty" data-sk="'+esc(k)+'" data-sp="'+esc(p.k)+'">'+
      ' <button class="chk spdel" data-sk="'+esc(k)+'" data-sp="'+esc(p.k)+'" title="✕">✕</button></div>').join('');
    return '<tr>'+
      cell(t('c_project'), esc(e.name), null, e.name.toLowerCase())+
      cell(t('sp_status'), status, null, m?(m.status==='now'?0:1):2)+
      cell(t('sp_phases_col'), phasesHtml)+
      cell(t('c_note'), '<input class="spnote" data-sk="'+esc(k)+'" value="'+esc(e.note||'')+'" placeholder="'+esc(t('sp_note_ph'))+'">')+
      cell('', '<button class="chk spdelall" data-sk="'+esc(k)+'" title="'+esc(t('sp_del_project'))+'">🗑</button>')+
    '</tr>';
  });
  document.getElementById('tSpots').innerHTML=
   '<thead><tr><th>'+t('c_project')+'</th><th>'+t('sp_status')+'</th><th>'+t('sp_phases_col')+'</th><th>'+t('c_note')+'</th><th></th></tr></thead><tbody>'+
   (spRows.join('') || '<tr><td colspan=5 class=muted>'+t('sp_empty')+'</td></tr>')+'</tbody>';
  const spPendEl=document.getElementById('spPending');
  if(spPendEl) spPendEl.textContent = spPend ? t('sp_pending_count').replace('{n}', spPend) : '';

  // Cartera y elegibilidad son personales: no tienen sentido en la web pública
  const walletTab=document.querySelector('#tabs button[data-t="wallet"]');
  if(walletTab) walletTab.hidden = !!D.public;
  if(D.public){ const wb=document.getElementById('wlBar'); if(wb) wb.hidden=true; }
  else { renderWlBar(); renderWallet(); }
  applyFilter();
  if(typeof applyHdr==='function') applyHdr();
}

document.getElementById('lang').addEventListener('click',e=>{
  const b=e.target.closest('button'); if(!b) return;
  L=b.dataset.l; localStorage.setItem('mints_lang',L); render();
  if(!helpM.hidden) fillHelp();
});
document.getElementById('hideLow').addEventListener('change',render);
document.getElementById('q').addEventListener('input',applyFilter);
document.getElementById('onlyKeys').addEventListener('change',applyFilter);
document.getElementById('wRealOnly').addEventListener('change',renderWallet);
document.getElementById('wHeldHide').addEventListener('change',renderWallet);
document.getElementById('chains').addEventListener('click',e=>{
  const b=e.target.closest('button'); if(!b) return;
  chainSel=b.dataset.c; try{ localStorage.setItem('mints_chain',chainSel); }catch(err){}
  render();
});
document.addEventListener('change',e=>{
  const chk=e.target.closest('.ownchk'); if(!chk) return;
  setOwned(chk.dataset.name, chk.checked);
});
// ---- Plazas: alta / baja / cantidad ----
(function(){
  const add=document.getElementById('spAdd');
  if(!add) return;
  const nEl=document.getElementById('spName'), pEl=document.getElementById('spPhase'), qEl=document.getElementById('spQty');
  const submit=()=>{ addSpot(nEl.value, pEl.value, qEl.value); nEl.value=''; pEl.value=''; qEl.value='1'; nEl.focus(); };
  add.addEventListener('click',submit);
  [nEl,pEl,qEl].forEach(el=>el.addEventListener('keydown',ev=>{ if(ev.key==='Enter'){ ev.preventDefault(); submit(); } }));
})();
document.addEventListener('click',e=>{
  const d=e.target.closest('.spdel'); if(d){ removeSpot(d.dataset.sk, d.dataset.sp); return; }
  const da=e.target.closest('.spdelall'); if(da) removeProject(da.dataset.sk);
});
document.addEventListener('change',e=>{
  const q=e.target.closest('.spqty'); if(q){ setSpotQty(q.dataset.sk, q.dataset.sp, q.value); return; }
  const a=e.target.closest('.spassign'); if(a){ if(a.value) reassignSpot(a.dataset.sk, a.value); return; }
  const n=e.target.closest('.spnote'); if(n) setSpotNote(n.dataset.sk, n.value);
});
document.addEventListener('click',e=>{
  const ab=e.target.closest('#alertBanner button');
  if(ab){
    const v=ab.dataset.abi;
    if(v==='all') alertQ=[]; else alertQ.splice(+v,1);
    saveQ(); renderAlertBanner();
    return;
  }
  const item=e.target.closest('#alertMenu button');
  if(item){
    const name=document.getElementById('alertMenu').dataset.name;
    const f=item.dataset.f;
    closeAlertMenu();
    if(f==='__off') disarmAlert(name); else armAlert(name, f);
    return;
  }
  if(e.target.closest('#alertMenu')) return;
  const b=e.target.closest('.bell');
  if(b){
    e.stopPropagation();
    unlockAudio();
    const r=b.getBoundingClientRect();
    openAlertMenu(b.dataset.alert, r.left, r.bottom+4);
    return;
  }
  closeAlertMenu();
});
document.addEventListener('keydown',e=>{ if(e.key==='Escape') closeAlertMenu(); });
const rb=document.getElementById('refreshBtn');
if(rb) rb.addEventListener('click',()=>reload(true));
const helpM=document.getElementById('helpModal');
function fillHelp(){ document.getElementById('helpBody').innerHTML = t('help'); }
document.getElementById('helpBtn').addEventListener('click',()=>{ fillHelp(); helpM.hidden=false; });
document.getElementById('helpClose').addEventListener('click',()=>helpM.hidden=true);
helpM.addEventListener('click',e=>{ if(e.target===helpM) helpM.hidden=true; });
document.addEventListener('keydown',e=>{ if(e.key==='Escape') helpM.hidden=true; });

// cabecera plegable (solo afecta a móvil vía CSS). Estado en localStorage.
const hdrEl=document.querySelector('header'), hdrTog=document.getElementById('hdrToggle');
function applyHdr(){
  let v; try{ v=localStorage.getItem('mints_hdr'); }catch(e){}
  const collapsed = v==='1';
  hdrEl.classList.toggle('hcollapsed', collapsed);
  hdrTog.textContent = collapsed ? '☰' : '✕';
  hdrTog.title = t(collapsed ? 'hdr_show' : 'hdr_hide');
}
hdrTog.addEventListener('click',()=>{
  const next = !hdrEl.classList.contains('hcollapsed');
  try{ localStorage.setItem('mints_hdr', next?'1':'0'); }catch(e){}
  applyHdr();
});
applyHdr();

document.getElementById('tabs').addEventListener('click',e=>{
  const b=e.target.closest('button'); if(!b) return;
  document.querySelectorAll('#tabs button').forEach(x=>x.classList.toggle('on',x===b));
  document.querySelectorAll('section[data-p]').forEach(s=>s.hidden = s.dataset.p!==b.dataset.t);
});
document.addEventListener('click',e=>{
  const th=e.target.closest('th'); if(!th) return;
  const tb=th.closest('table'), i=[...th.parentNode.children].indexOf(th);
  const body=tb.tBodies[0]||tb;
  const rows=body===tb ? [...tb.querySelectorAll('tr')].slice(1) : [...body.rows];
  const asc=th.dataset.asc==='1'; th.dataset.asc=asc?'0':'1';
  rows.sort((a,b)=>{
    const ca=a.children[i], cb=b.children[i];
    const sa=ca&&ca.dataset.sort, sb=cb&&cb.dataset.sort;
    let v;
    if(sa!=null && sb!=null){
      const na=parseFloat(sa), nb=parseFloat(sb);
      v = (!isNaN(na)&&!isNaN(nb)) ? na-nb : String(sa).localeCompare(String(sb));
    } else {
      const x=ca?ca.textContent.trim():'', y=cb?cb.textContent.trim():'';
      const nx=parseFloat(x.replace(/[^0-9.\\-]/g,'')),ny=parseFloat(y.replace(/[^0-9.\\-]/g,''));
      v=(!isNaN(nx)&&!isNaN(ny))?nx-ny:x.localeCompare(y);
    }
    return asc?-v:v;
  });
  rows.forEach(r=>body.appendChild(r));
});
render();
renderAlertBanner();            // re-muestra avisos pendientes tras recargar
if(SERVED){ fetchWlStatus(); setInterval(fetchWlStatus, 5*60000); }
setInterval(render, 60000); // los contadores bajan solos
checkAlerts();
setInterval(()=>{ checkAlerts(); renderAlertBanner(); }, 30000);
</script>
</body></html>`;
}
