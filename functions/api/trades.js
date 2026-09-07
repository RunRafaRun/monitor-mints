// Cloudflare Pages Function — P&L on-chain de una wallet en UNA red.
//
//   POST /api/trades  { address, chain, collections?: [contract...] }
//     -> { chain, ethUsd, positions:[...], truncated, partial }
//
// Reconstruye compras/ventas de NFT leyendo la cadena vía Blockscout PRO
// (3 listas paginadas + cálculo FIFO, igual que scripts/fetch-trades.mjs).
// Si se pasa `collections` solo procesa esas (lo que marcas en la web).
// Floor de las posiciones vivas vía OpenSea. Caché 6 h por (address·chain·cols).
//
// Requiere BLOCKSCOUT_API_KEY (y OPENSEA_API_KEY para floors) como env vars.

const CHAIN_ID = { robinhood: 4663, ethereum: 1, ink: 57073, base: 8453 };
const OS_CHAIN = { robinhood: "robinhood", ethereum: "ethereum", ink: "ink", base: "base" };
const ZERO = "0x0000000000000000000000000000000000000000";
// cualquier símbolo con "USD"/"DOLLAR" (USDG, USDC, USDC.E, USDT, USDB, USD.0, USDe…) o DAI/GHO/PYUSD -> lo tratamos como ~1 $
const STABLE = /USD|DOLLAR|^DAI$|^GHO$|^PYUSD$/i;
const ETHLIKE = /^(W?ETH|WETH\.E)$/i;
const SALE_METHODS = /order|fulfill|match|swap|trade|buy|accept|purchase|takeAsk|takeBid|sweep/i;
const TTL = 6 * 3600;
const CACHE_V = "9";      // súbelo al cambiar la lógica de cálculo -> invalida la caché
const MAX_PAGES = 16;      // ~800 movimientos por lista
const MAX_FLOOR = 18;

export async function onRequestPost(ctx) {
  try {
    return await handle(ctx);
  } catch (e) {
    return j({ error: "server_error", detail: String((e && e.message) || e).slice(0, 200) }, 500);
  }
}

async function handle({ request, env }) {
  const BS = env.BLOCKSCOUT_API_KEY;
  if (!BS) return j({ error: "not_configured" }, 503);
  const OS = env.OPENSEA_API_KEY || "";
  const BUDGET = Number(env.TRADES_SUBREQ_BUDGET) || 40;   // tope de fetches por petición (Cloudflare free = 50; súbelo con env var si tienes plan de pago)
  let subreq = 0;

  const { address, chain, collections, ethUsd: rateIn, contractsOnly } = await request.json().catch(() => ({}));
  const addr = String(address || "").trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(addr)) return j({ error: "bad_address" }, 400);
  const cid = CHAIN_ID[chain];
  if (!cid) return j({ error: "bad_chain" }, 400);
  const want = Array.isArray(collections) && collections.length
    ? new Set(collections.map((c) => String(c).toLowerCase()))
    : null;

  const cacheKey = new Request(
    `https://x/trades?v=${CACHE_V}&a=${addr}&c=${chain}&k=${want ? [...want].sort().join(",").slice(0, 400) : "all"}`,
    { method: "GET" },
  );
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const base = `https://api.blockscout.com/${cid}/api/v2`;
  let apiErr = 0, truncated = false;

  // pool: máx 3 llamadas Blockscout en vuelo
  let inFlight = 0; const queue = [];
  const acquire = () => new Promise((r) => { if (inFlight < 3) { inFlight++; r(); } else queue.push(r); });
  const release = () => { inFlight--; const n = queue.shift(); if (n) { inFlight++; setTimeout(n, 110); } };
  async function bs(path, params = {}) {
    if (subreq >= BUDGET) { truncated = true; return null; }
    await acquire();
    try {
      const u = new URL(base + path);
      for (const [k, v] of Object.entries({ ...params, apikey: BS })) if (v != null) u.searchParams.set(k, v);
      for (let t = 0; t < 3; t++) {
        if (subreq >= BUDGET) { truncated = true; return null; }
        subreq++;
        const backoff = Math.min(500 * 2 ** t, 2500);
        let r;
        try { r = await fetch(u, { headers: { accept: "application/json" } }); }
        catch { await sleep(backoff); continue; }
        if (r.status === 429 || r.status === 402 || r.status >= 500) { await sleep(backoff); continue; }
        if (!r.ok) { apiErr++; return null; }
        const jr = await r.json().catch(() => null);
        // Blockscout PRO a veces responde 200 con {"error":...,"source":"upstream"}
        if (jr && jr.error && jr.source === "upstream") { await sleep(backoff); continue; }
        return jr;
      }
      apiErr++; return null;
    } finally { release(); }
  }
  async function bsList(path, baseParams, map, maxPages = MAX_PAGES) {
    const out = [];
    let params = { ...baseParams };
    for (let p = 0; p < maxPages; p++) {
      const jr = await bs(path, params);
      if (!jr) { if (p > 0) truncated = true; break; }   // corte a media paginación -> resultado incompleto
      for (const it of jr.items || []) { const v = map(it); if (v) out.push(v); }
      if (!jr.next_page_params) break;
      params = jr.next_page_params;
      if (p === maxPages - 1) truncated = true;
    }
    return out;
  }

  // modo "solo enumerar colecciones" (para trocear wallets muy activas en lotes)
  if (contractsOnly) {
    const ck2 = new Request(`https://x/tcontracts?v=${CACHE_V}&a=${addr}&c=${chain}`, { method: "GET" });
    const h2 = await cache.match(ck2);
    if (h2) return h2;
    const seen = new Map();
    const add = (ct, name, n, held) => {
      if (!ct) return;
      const e = seen.get(ct) || { contract: ct, name: null, count: 0, held: false };
      e.count += n || 0; if (!e.name && name) e.name = name; if (held) e.held = true;
      seen.set(ct, e);
    };
    // 1) colecciones que la wallet tiene AHORA (1 fila por colección -> barato)
    const cmap = (it) => ({ ct: (it.token?.address_hash || it.token?.address || "").toLowerCase(), name: it.token?.name || null, n: Number(it.amount || it.value) || (it.token_instances || []).length || 1 });
    const [collA, collB] = await Promise.all([
      bsList(`/addresses/${addr}/nft/collections`, { type: "ERC-721" }, cmap, 5),
      bsList(`/addresses/${addr}/nft/collections`, { type: "ERC-1155" }, cmap, 3),
    ]);
    for (const x of [...collA, ...collB]) add(x.ct, x.name, x.n, true);
    // 2) barrido corto de transferencias recientes -> colecciones ya vendidas/salidas
    const tmap = (it) => ({ ct: (it.token?.address_hash || it.token?.address || "").toLowerCase(), name: it.token?.name || null });
    const recent = await bsList(`/addresses/${addr}/token-transfers`, { type: "ERC-721,ERC-1155" }, tmap, 5);
    for (const x of recent) if (!seen.has(x.ct)) add(x.ct, x.name, 1, false);
    const contracts = [...seen.values()].sort((a, b) => (b.held - a.held) || (b.count - a.count));
    const r2 = j({ chain, contracts, truncated, subreq }, 200,
      { "cache-control": `public, max-age=${truncated || !contracts.length ? 120 : 3600}` });
    if (!truncated && contracts.length) await cache.put(ck2, r2.clone());
    return r2;
  }

  const nftMap = (it) => ({
    contract: (it.token?.address_hash || it.token?.address || "").toLowerCase(),
    tokenId: it.total?.token_id ?? it.total?.id ?? null,
    from: (it.from?.hash || "").toLowerCase(),
    to: (it.to?.hash || "").toLowerCase(),
    ts: Date.parse(it.timestamp) || null,
    tx: it.transaction_hash,
    name: it.token?.name || null,
    method: it.method || null,
    logIndex: it.log_index,
    toContract: !!(it.to?.is_contract),
  });
  // si el filtro de colecciones es corto -> pide los NFT colección a colección
  // (acotado y completo); si no, la lista entera de la wallet (puede truncarse)
  const nftFetch = want && want.size <= 10
    ? Promise.all([...want].map((ct) =>
        bsList(`/addresses/${addr}/token-transfers`, { type: "ERC-721,ERC-1155", token: ct }, nftMap, 8),
      )).then((a) => a.flat())
    : bsList(`/addresses/${addr}/token-transfers`, { type: "ERC-721,ERC-1155" }, nftMap, MAX_PAGES);

  const [nft, erc20, sent, nativeIn, rateFetched] = await Promise.all([
    nftFetch,
    bsList(`/addresses/${addr}/token-transfers`, { type: "ERC-20" }, (it) => {
      const sym = it.token?.symbol || "";
      const kind = ETHLIKE.test(sym) ? "eth" : STABLE.test(sym) ? "usd" : null;
      if (!kind) return null;
      const dec = Number(it.token?.decimals) || 18;
      const amt = Number(it.total?.value) / 10 ** dec;
      if (!amt) return null;
      return { tx: it.transaction_hash, kind, amt, from: (it.from?.hash || "").toLowerCase(), to: (it.to?.hash || "").toLowerCase() };
    }),
    bsList(`/addresses/${addr}/transactions`, { filter: "from" }, (it) => ({
      tx: it.hash, gasEth: (Number(it.fee?.value) || 0) / 1e18, nativeEth: (Number(it.value) || 0) / 1e18,
    })),
    // valor nativo RECIBIDO por la wallet (los pagos de venta de un marketplace
    // llegan como transacción interna, no como tx propia ni como ERC-20)
    bsList(`/addresses/${addr}/internal-transactions`, { filter: "to" }, (it) => {
      const to = (it.to?.hash || it.to || "").toLowerCase();
      if (to !== addr) return null;
      const v = (Number(it.value) || 0) / 1e18;
      return v > 0 ? { tx: it.transaction_hash || it.tx_hash, eth: v } : null;
    }, 6),
    rateIn > 100 ? Promise.resolve(rateIn) : ethUsd(),
  ]);
  const rate = rateFetched;

  if (!nft.length && apiErr) return j({ error: "blockscout_down" }, 502);

  const payByTx = new Map();
  for (const p of erc20) { if (!payByTx.has(p.tx)) payByTx.set(p.tx, []); payByTx.get(p.tx).push(p); }
  const sentByTx = new Map(sent.map((s) => [s.tx, s]));
  const nativeInByTx = new Map();
  for (const n of nativeIn) nativeInByTx.set(n.tx, (nativeInByTx.get(n.tx) || 0) + n.eth);
  const own = new Set([addr]);

  const seen = new Set();
  const events = nft.filter((e) => {
    if (want && !want.has(e.contract)) return false;
    const k = `${e.tx}:${e.contract}:${e.tokenId}:${e.from}:${e.to}:${e.logIndex}`;
    if (seen.has(k)) return false; seen.add(k); return true;
  });

  const payTotals = (pays, party, dir) => {
    let eth = 0, usd = 0;
    for (const p of pays || []) {
      if (dir === "out" && p.from !== party) continue;
      if (dir === "in" && p.to !== party) continue;
      if (p.kind === "eth") eth += p.amt; else usd += p.amt;
    }
    return { eth, usd };
  };

  const byNft = new Map();
  for (const e of events) {
    if (e.tokenId == null) continue;
    const k = `${e.contract}:${e.tokenId}`;
    if (!byNft.has(k)) byNft.set(k, []);
    byNft.get(k).push(e);
  }

  const positions = [];
  for (const [, list] of byNft) {
    list.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    const info = list.find((e) => e.name) || list[0];
    const lots = [];
    for (const e of list) {
      const acq = own.has(e.to) && !own.has(e.from);
      const dis = own.has(e.from) && !own.has(e.to);
      if (own.has(e.to) && own.has(e.from)) continue;
      const P = payByTx.get(e.tx) || [];
      const S = sentByTx.get(e.tx) || null;
      if (acq) {
        const isMint = e.from === ZERO;
        // pago = tokens ERC-20 que la wallet manda en la tx + valor nativo de la tx.
        // También para mints: hay colecciones que cobran el mint en USDG/USDC o en nativo.
        const o = payTotals(P, e.to, "out");
        let priceEth = o.eth, priceUsd = o.usd;
        if (S?.nativeEth) priceEth += S.nativeEth;
        const gasEth = S ? S.gasEth : 0;
        const priceTotalEth = priceEth + (priceUsd ? priceUsd / rate : 0);  // precio real, SIN gas
        const costEth = priceTotalEth + gasEth;                             // coste con gas -> P&L FIFO
        const paid = priceEth > 0 || priceUsd > 0;
        // ¿la tx parece una compra en un marketplace? (método fulfill/order/match…)
        const looksSale = SALE_METHODS.test(e.method || "");
        // recibida sin pago y SIN pinta de venta -> regalo/airdrop/claim (coste 0 REAL).
        // Con pinta de venta pero sin pago decodificado -> coste DESCONOCIDO.
        const isGift = !isMint && !paid && !looksSale;
        const kind = isMint ? "mint" : paid ? "buy" : isGift ? "gift" : "transfer_in";
        lots.push({ ts: e.ts, kind, priceEth: round(priceTotalEth), priceUsd: round(priceUsd), costEth, gasEth, tx: e.tx,
          flags: isMint && !paid ? ["free_mint"] : isGift ? ["gift"] : (!isMint && !paid) ? ["cost_unknown"] : [] });
      } else if (dis) {
        const inc = payTotals(P, e.from, "in");
        const natIn = nativeInByTx.get(e.tx) || 0;               // ETH nativo recibido (pago del marketplace)
        const incEth = inc.eth + natIn;
        const isSale = (incEth + inc.usd) > 0;
        const gasEth = S ? S.gasEth : 0;
        const grossEth = isSale ? incEth + (inc.usd ? inc.usd / rate : 0) : null;   // ingreso bruto
        const procEth = grossEth != null ? grossEth - gasEth : null;                 // neto de gas -> realized
        const lot = lots.shift() || { ts: null, kind: "unknown", priceEth: null, costEth: null, gasEth: 0, flags: ["no_acq"] };
        positions.push({
          chain, contract: info.contract, tokenId: info.tokenId,
          name: info.name ? `${info.name} #${info.tokenId}` : `#${info.tokenId}`,
          url: `https://opensea.io/assets/${OS_CHAIN[chain]}/${info.contract}/${info.tokenId}`,
          acquired: lot.ts ? { ts: lot.ts, type: lot.kind, priceEth: lot.priceEth, priceUsd: lot.priceUsd || null, gasEth: lot.gasEth, tx: lot.tx } : null,
          disposed: { ts: e.ts, type: isSale ? "sale" : e.toContract ? "sent_to_contract" : "transfer_out", priceEth: isSale ? round(grossEth) : null, gasEth, tx: e.tx },
          status: isSale ? "sold" : "moved_out",
          realizedEth: (isSale && lot.costEth != null) ? round(procEth - lot.costEth) : null,
          flags: [...new Set([...(lot.flags || []), ...(isSale ? [] : [e.toContract ? "redeemed_or_bridged" : "sold_elsewhere_or_gift"])])],
        });
      }
    }
    for (const lot of lots) {
      positions.push({
        chain, contract: info.contract, tokenId: info.tokenId,
        name: info.name ? `${info.name} #${info.tokenId}` : `#${info.tokenId}`,
        url: `https://opensea.io/assets/${OS_CHAIN[chain]}/${info.contract}/${info.tokenId}`,
        acquired: { ts: lot.ts, type: lot.kind, priceEth: lot.priceEth, priceUsd: lot.priceUsd || null, gasEth: lot.gasEth, tx: lot.tx },
        disposed: null, status: "held", realizedEth: null, flags: lot.flags || [],
      });
    }
  }

  // floor de las colecciones que aún tienes (prioriza donde más NFT tienes)
  if (OS) {
    const held = new Map();
    for (const p of positions) if (p.status === "held") held.set(p.contract, (held.get(p.contract) || 0) + 1);
    const top = [...held.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_FLOOR).map((x) => x[0]);
    const OH = { accept: "application/json", "x-api-key": OS };
    const floors = {};
    for (const contract of top) {
      if (subreq >= BUDGET - 1) { truncated = true; break; }
      subreq++;
      const c = await fetch(`https://api.opensea.io/api/v2/chain/${OS_CHAIN[chain]}/contract/${contract}`, { headers: OH }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      const slug = c?.collection;
      if (!slug) continue;
      subreq++;
      const st = await fetch(`https://api.opensea.io/api/v2/collections/${slug}/stats`, { headers: OH }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      const fp = st?.total?.floor_price;
      if (fp != null) floors[contract] = { floorEth: +fp, floorUsd: +(fp * rate).toFixed(2) };
    }
    for (const p of positions) {
      const f = floors[p.contract];
      if (f) { p.floorEth = f.floorEth; p.floorUsd = f.floorUsd; if (p.status === "held" && p.acquired?.priceEth != null) p.unrealizedEth = round(f.floorEth - p.acquired.priceEth); }
    }
  }

  const body = { chain, ethUsd: rate, positions, truncated, partial: apiErr > 0, updated: new Date().toISOString() };
  const res = j(body, 200, { "cache-control": `public, max-age=${TTL}` });
  await cache.put(cacheKey, res.clone());
  return res;
}

async function ethUsd() {
  try { return (await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd").then((r) => r.json())).ethereum.usd; }
  catch { return 2500; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (n) => (n == null ? null : +Number(n).toFixed(6));
function j(o, s = 200, extra = {}) {
  return new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json; charset=utf-8", ...extra } });
}
