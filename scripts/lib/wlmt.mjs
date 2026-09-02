// Fuente de datos secundaria: tabla pública "daily_mints" (Supabase REST).
// Solo datos — no se muestra ninguna referencia a su origen en el dashboard.
//
// Config en scripts/.env (opcional; si falta, esta fuente se ignora sin más):
//   WLMT_URL=https://<proyecto>.supabase.co
//   WLMT_KEY=<anon/public key>   (clave pública, va en el JS del sitio)
//
// Uso: const rows = await fetchDailyMints("robinhood");  -> [] si no configurado o falla.
//
// Esquema real (2026-09):
//   row: project_name, description, supply(string), chain, twitter_url, website_url,
//        mint_url(opensea), mint_date, mint_phases[]
//   phase: { label, price(string), currency, date|mint_date (inicio), end_date }
//   NO trae: colecciones elegibles, allocation/limit, contrato, minteados en vivo.

export async function fetchDailyMints(chain = "robinhood") {
  const url = process.env.WLMT_URL;
  const key = process.env.WLMT_KEY;
  if (!url || !key) return [];
  try {
    const q = `${url}/rest/v1/daily_mints?select=project_name,description,supply,chain,twitter_url,website_url,mint_url,mint_date,mint_phases&chain=eq.${chain}&order=mint_date.desc&limit=200`;
    const r = await fetch(q, {
      headers: { apikey: key, authorization: `Bearer ${key}`, accept: "application/json" },
    });
    if (!r.ok) { console.error("wlmt:", r.status); return []; }
    const raw = await r.json();
    return raw.map(normalize).filter((x) => x && x.phases.length);
  } catch (e) {
    console.error("wlmt:", e.message);
    return [];
  }
}

function normalize(row) {
  const name = (row.project_name || "").trim();
  if (!name) return null;
  const phases = (Array.isArray(row.mint_phases) ? row.mint_phases : []).map(normPhase).filter(Boolean);
  return {
    name,
    chain: (row.chain || "robinhood").toLowerCase(),
    supply: numOrNull(row.supply),
    slug: slugFrom(row.mint_url),
    x: row.twitter_url || null,
    site: row.website_url || null,
    // fecha de referencia = inicio de la 1ª fase (el mint_date de la fila no es fiable)
    mintDate: phases[0]?.startMs ?? toMs(row.mint_date),
    phases,
    contract: null,
  };
}

function normPhase(p) {
  if (!p || typeof p !== "object") return null;
  const label = String(p.label || p.name || "").trim();
  const u = label.toUpperCase();
  const kind =
    /FCFS/.test(u) ? "FCFS" :
    /GTD/.test(u) ? "GTD" :
    /TEAM|TREASURY|PARTNER/.test(u) ? "TEAM" :
    /HOLDER/.test(u) ? "HOLDER" :
    /PUBLIC/.test(u) ? "PUBLIC" :
    /WL|ALLOW|WHITELIST|LIST/.test(u) ? "WL" : "OTHER";
  const priceNum = numOrNull(p.price);
  const cur = String(p.currency || "ETH").toUpperCase();
  return {
    kind,
    label,
    priceEth: cur === "ETH" || cur === "WETH" ? priceNum : null,
    priceUsd: cur !== "ETH" && cur !== "WETH" ? priceNum : null,
    currency: cur,
    free: priceNum === 0,
    allocation: null,
    startMs: toMs(p.date || p.mint_date || p.start_date),
    endMs: toMs(p.end_date || p.end),
    eligible: [], // esta fuente no las trae
  };
}

const numOrNull = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const toMs = (v) => { if (!v) return null; const t = typeof v === "number" ? v : Date.parse(v); return Number.isFinite(t) ? (t < 1e12 ? t * 1000 : t) : null; };
function slugFrom(u) {
  if (!u) return null;
  const m = String(u).match(/opensea\.io\/(?:collection|assets\/\w+)\/([^/?#]+)/);
  return m ? m[1] : null;
}
