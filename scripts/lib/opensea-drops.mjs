// Fuente adicional: catálogo de "Drops" (SeaDrop) de la propia API de OpenSea.
//
// A diferencia de NFT Trencher y WLMT (que agregan por su cuenta, con retraso),
// esto lee directo `api.opensea.io/v2/drops` — sirve para detectar mints en
// cadenas muy nuevas (Arc, Monad…) antes de que Trencher las añada a su feed.
// Solo cubre colecciones que usan el "Drops" propio de OpenSea (SeaDrop): un
// mint anunciado solo por X/Discord sin pasar por ahí no va a aparecer aquí.
//
// Uso: const byChain = await fetchOpenSeaDropsAll(["arc","monad"]);
//      byChain.get("arc") -> filas en el mismo formato que wlmt.mjs::fetchDailyMints

const OS = "https://api.opensea.io";
const TYPES = ["upcoming", "featured", "recently_minted"];
const MAX_DROPS = 60; // tope total de slugs a detallar (1 fetch por slug)

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
const toEth = (wei) => { const n = Number(wei); return Number.isFinite(n) ? n / 1e18 : null; };
const toMs = (s) => { const t = Date.parse(s || ""); return Number.isFinite(t) ? t : null; };

// devuelve un Map chain -> filas (una entrada por chain pedido, aunque venga vacía)
export async function fetchOpenSeaDropsAll(chains) {
  const out = new Map(chains.map((c) => [c, []]));
  const key = process.env.OPENSEA_API_KEY;
  if (!key) return out;
  const H = { accept: "application/json", "x-api-key": key };
  const want = new Set(chains);

  try {
    const slugs = new Map(); // slug -> chain
    for (const type of TYPES) {
      const r = await fetch(`${OS}/api/v2/drops?type=${type}&limit=100`, { headers: H });
      if (!r.ok) continue;
      const body = await r.json().catch(() => null);
      for (const d of body?.drops || []) {
        if (!want.has(d.chain) || !d.collection_slug) continue;
        if (!slugs.has(d.collection_slug)) slugs.set(d.collection_slug, d.chain);
        if (slugs.size >= MAX_DROPS) break;
      }
    }

    let n = 0;
    for (const [slug, chain] of slugs) {
      n++;
      try {
        const r = await fetch(`${OS}/api/v2/drops/${slug}`, { headers: H });
        if (r.ok) {
          const meta = await r.json().catch(() => null);
          const stages = Array.isArray(meta?.stages) ? meta.stages : [];
          const phases = stages.map((s) => ({
            kind: STAGE_KIND(s.stage_type, s.label),
            label: s.label || "",
            priceEth: toEth(s.price),
            priceUsd: null,
            currency: "ETH",
            free: Number(s.price) === 0,
            allocation: s.max_per_wallet != null ? Number(s.max_per_wallet) : (s.allowlist_wallet_count ?? null),
            startMs: toMs(s.start_time),
            endMs: toMs(s.end_time),
            eligible: [],
          }));
          if (phases.length) {
            out.get(chain).push({
              name: meta.collection_name || slug,
              chain,
              supply: meta.max_supply ? Number(meta.max_supply) : null,
              slug,
              x: null,
              site: null,
              mintDate: phases[0]?.startMs ?? null,
              phases,
              contract: (meta.contract_address || "").toLowerCase() || null,
            });
          }
        }
      } catch { /* siguiente slug */ }
      if (n % 5 === 0) await new Promise((res) => setTimeout(res, 200));
    }
  } catch (e) {
    console.error("opensea-drops:", e.message);
  }
  return out;
}

// Cadenas nuevas donde casi ninguna colección usa "Drops" (SeaDrop): sin fases,
// no hay forma de saber si un mint está "ahora" o "luego". En vez de eso listamos
// las colecciones con más volumen que YA tienen huella social (X/Discord/web) —
// filtro anti-spam necesario: en chains recién lanzadas, >99% de lo que se crea
// es basura de bots probando contratos (1-13 items, sin nombre/descr. real).
// Se muestran siempre que sigan en el top al generar (sin fechas reales, no hay
// "cuándo empezó/acaba" que guardar).
export async function fetchOpenSeaTopCollections(chain, { limit = 25 } = {}) {
  const key = process.env.OPENSEA_API_KEY;
  if (!key) return [];
  const H = { accept: "application/json", "x-api-key": key };
  const now = Date.now();
  try {
    const r = await fetch(`${OS}/api/v2/collections?chain=${chain}&order_by=market_cap&limit=100`, { headers: H });
    if (!r.ok) return [];
    const body = await r.json().catch(() => null);
    const out = [];
    for (const c of body?.collections || []) {
      const social = c.twitter_username || c.discord_url || c.project_url;
      if (!social || c.is_disabled) continue;
      const contract = (c.contracts || []).find((x) => x.chain === chain)?.address || null;
      out.push({
        name: c.name || c.collection,
        chain,
        supply: null,
        slug: c.collection,
        x: c.twitter_username ? `https://x.com/${c.twitter_username}` : null,
        site: c.project_url || c.discord_url || null,
        mintDate: null,
        phases: [{
          kind: "PUBLIC",
          label: "Colección activa (sin fases WL/GTD/FCFS en OpenSea)",
          priceEth: null, priceUsd: null, currency: "ETH", free: false, allocation: null,
          startMs: now - 3600e3, endMs: now + 24 * 3600e3, eligible: [],
        }],
        contract: contract ? contract.toLowerCase() : null,
      });
      if (out.length >= limit) break;
    }
    return out;
  } catch (e) {
    console.error("opensea-drops (top):", e.message);
    return [];
  }
}
