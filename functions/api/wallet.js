// Cloudflare Pages Function — GET /api/wallet?address=0x…
// Devuelve las colecciones de NFT que tiene una wallet (por cadena), leídas de
// OpenSea con la clave del servidor. El front las cruza con las colecciones de
// "acceso" del radar para marcar en qué mints calificas.
//
// NO comprueba si estás en la lista firmada GTD/FCFS de un drop: eso OpenSea solo
// lo expone con la sesión de esa misma wallet (scope read:eligibility), no con
// una API key. Eso sigue siendo solo para el modo local (serve.mjs).
//
// Requiere la variable de entorno OPENSEA_API_KEY en el proyecto de Pages.

const CHAINS = ["robinhood", "ethereum", "ink", "base"];
const TTL = 900; // 15 min de caché por dirección
const MAX_PAGES = 6; // ~1200 NFT por cadena

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const addr = (url.searchParams.get("address") || "").trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(addr)) {
    return json({ error: "bad_address" }, 400);
  }
  if (!env.OPENSEA_API_KEY) {
    return json({ error: "not_configured" }, 503);
  }

  const cache = caches.default;
  const cacheKey = new Request(`${url.origin}/api/wallet?address=${addr}`, { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const H = { accept: "application/json", "x-api-key": env.OPENSEA_API_KEY };
  const chains = {};
  const collections = new Map();
  let apiErr = 0;

  for (const chain of CHAINS) {
    const slugs = new Set();
    let next = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const u = `https://api.opensea.io/api/v2/chain/${chain}/account/${addr}/nfts?limit=200${next ? `&next=${encodeURIComponent(next)}` : ""}`;
      let r;
      try { r = await fetch(u, { headers: H }); } catch { apiErr++; break; }
      if (!r.ok) { if (r.status === 401 || r.status === 429) apiErr++; break; }
      const j = await r.json().catch(() => ({}));
      for (const n of j.nfts || []) {
        const slug = n.collection;
        if (!slug) continue;
        slugs.add(slug);
        if (!collections.has(slug)) {
          collections.set(slug, {
            slug,
            contract: n.contract || null,
            name: (n.name || "").replace(/\s*#\s*\d[\w-]*$/, "").trim() || slug,
            chains: new Set(),
          });
        }
        collections.get(slug).chains.add(chain);
      }
      next = j.next || null;
      if (!next) break;
    }
    chains[chain] = [...slugs];
  }

  const body = {
    address: addr,
    updated: new Date().toISOString(),
    chains,
    collections: [...collections.values()].map((c) => ({ ...c, chains: [...c.chains] })),
    partial: apiErr > 0,
  };
  const res = json(body, 200, { "cache-control": `public, max-age=${TTL}` });
  await cache.put(cacheKey, res.clone());
  return res;
}

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });
}
