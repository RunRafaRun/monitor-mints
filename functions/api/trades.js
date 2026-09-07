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
const STABLE = /^(USDG|USDC|USDC\.E|USDT|USD.0|DAI|USDB|USDB\.E)$/i;
const ETHLIKE = /^(W?ETH)$/i;
const TTL = 6 * 3600;
const MAX_PAGES = 16;      // ~800 movimientos por lista
const MAX_FLOOR = 18;

export async function onRequestPost({ request, env }) {
  const BS = env.BLOCKSCOUT_API_KEY;
  if (!BS) return j({ error: "not_configured" }, 503);
  const OS = env.OPENSEA_API_KEY || "";

  const { address, chain, collections, ethUsd: rateIn } = await request.json().catch(() => ({}));
  const addr = String(address || "").trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(addr)) return j({ error: "bad_address" }, 400);
  const cid = CHAIN_ID[chain];
  if (!cid) return j({ error: "bad_chain" }, 400);
  const want = Array.isArray(collections) && collections.length
    ? new Set(collections.map((c) => String(c).toLowerCase()))
    : null;

  const cacheKey = new Request(
    `https://x/trades?a=${addr}&c=${chain}&k=${want ? [...want].sort().join(",").slice(0, 400) : "all"}`,
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
    await acquire();
    try {
      const u = new URL(base + path);
      for (const [k, v] of Object.entries({ ...params, apikey: BS })) if (v != null) u.searchParams.set(k, v);
      for (let t = 0; t < 5; t++) {
        let r;
        try { r = await fetch(u, { headers: { accept: "application/json" } }); }
        catch { await sleep(800); continue; }
        if (r.status === 429 || r.status === 402 || r.status >= 500) { await sleep(700 * 2 ** t); continue; }
        if (!r.ok) { apiErr++; return null; }
        const jr = await r.json().catch(() => null);
        // Blockscout PRO a veces responde 200 con {"error":...,"source":"upstream"}
        if (jr && jr.error && jr.source === "upstream") { await sleep(700 * 2 ** t); continue; }
        return jr;
      }
      apiErr++; return null;
    } finally { release(); }
  }
  async function bsList(path, baseParams, map) {
    const out = [];
    let params = { ...baseParams };
    for (let p = 0; p < MAX_PAGES; p++) {
      const jr = await bs(path, params);
      if (!jr) break;
      for (const it of jr.items || []) { const v = map(it); if (v) out.push(v); }
      if (!jr.next_page_params) break;
      params = jr.next_page_params;
      if (p === MAX_PAGES - 1) truncated = true;
    }
    return out;
  }

  const [nft, erc20, sent, rateFetched] = await Promise.all([
    bsList(`/addresses/${addr}/token-transfers`, { type: "ERC-721,ERC-1155" }, (it) => ({
      contract: (it.token?.address_hash || it.token?.address || "").toLowerCase(),
      tokenId: it.total?.token_id ?? it.total?.id ?? null,
      from: (it.from?.hash || "").toLowerCase(),
      to: (it.to?.hash || "").toLowerCase(),
      ts: Date.parse(it.timestamp) || null,
      tx: it.transaction_hash,
      name: it.token?.name || null,
      logIndex: it.log_index,
    })),
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
    rateIn > 100 ? Promise.resolve(rateIn) : ethUsd(),
  ]);
  const rate = rateFetched;

  if (!nft.length && apiErr) return j({ error: "blockscout_down" }, 502);

  const payByTx = new Map();
  for (const p of erc20) { if (!payByTx.has(p.tx)) payByTx.set(p.tx, []); payByTx.get(p.tx).push(p); }
  const sentByTx = new Map(sent.map((s) => [s.tx, s]));
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
        let priceEth = 0, priceUsd = 0;
        if (isMint) { if (S) priceEth = S.nativeEth; }
        else { const o = payTotals(P, e.to, "out"); priceEth = o.eth; priceUsd = o.usd; if (S?.nativeEth) priceEth += S.nativeEth; }
        const gasEth = S ? S.gasEth : 0;
        const costEth = priceEth + (priceUsd ? priceUsd / rate : 0) + gasEth;
        const paid = priceEth > 0 || priceUsd > 0;
        // recibida sin pago Y la wallet NO firmó la tx ni movió tokens -> regalo/airdrop
        // (coste 0 REAL). Si la wallet firmó pero no detectamos pago -> coste desconocido.
        const isGift = !isMint && !paid && !S && !(P && P.length);
        const kind = isMint ? "mint" : paid ? "buy" : isGift ? "gift" : "transfer_in";
        lots.push({ ts: e.ts, kind, costEth, gasEth, tx: e.tx,
          flags: isMint && !paid ? ["free_mint"] : isGift ? ["gift"] : (!isMint && !paid) ? ["cost_unknown"] : [] });
      } else if (dis) {
        const inc = payTotals(P, e.from, "in");
        const isSale = (inc.eth + inc.usd) > 0;
        const gasEth = S ? S.gasEth : 0;
        const procEth = isSale ? (inc.eth + (inc.usd ? inc.usd / rate : 0)) - gasEth : null;
        const lot = lots.shift() || { ts: null, kind: "unknown", costEth: null, gasEth: 0, flags: ["no_acq"] };
        positions.push({
          chain, contract: info.contract, tokenId: info.tokenId,
          name: info.name ? `${info.name} #${info.tokenId}` : `#${info.tokenId}`,
          url: `https://opensea.io/assets/${OS_CHAIN[chain]}/${info.contract}/${info.tokenId}`,
          acquired: lot.ts ? { ts: lot.ts, type: lot.kind, priceEth: lot.costEth, gasEth: lot.gasEth, tx: lot.tx } : null,
          disposed: { ts: e.ts, type: isSale ? "sale" : "transfer_out", priceEth: isSale ? procEth : null, gasEth, tx: e.tx },
          status: isSale ? "sold" : "moved_out",
          realizedEth: (isSale && lot.costEth != null) ? round(procEth - lot.costEth) : null,
          flags: [...new Set([...(lot.flags || []), ...(isSale ? [] : ["sold_elsewhere_or_gift"])])],
        });
      }
    }
    for (const lot of lots) {
      positions.push({
        chain, contract: info.contract, tokenId: info.tokenId,
        name: info.name ? `${info.name} #${info.tokenId}` : `#${info.tokenId}`,
        url: `https://opensea.io/assets/${OS_CHAIN[chain]}/${info.contract}/${info.tokenId}`,
        acquired: { ts: lot.ts, type: lot.kind, priceEth: lot.costEth, gasEth: lot.gasEth, tx: lot.tx },
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
      const c = await fetch(`https://api.opensea.io/api/v2/chain/${OS_CHAIN[chain]}/contract/${contract}`, { headers: OH }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      const slug = c?.collection;
      if (!slug) continue;
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
