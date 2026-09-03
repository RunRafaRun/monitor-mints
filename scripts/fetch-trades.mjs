// Cartera / P&L — reconstruye compras y ventas de NFT de tus wallets leyendo la
// BLOCKCHAIN directamente (Blockscout PRO API), sin depender de OpenSea.
//
//   node fetch-trades.mjs           -> data/trades.json  (lo lee el dashboard)
//   node fetch-trades.mjs --json    además vuelca el resultado por stdout
//
// Necesita BLOCKSCOUT_API_KEY en scripts/.env (gratis, empieza por proapi_) y
// data/wallets.json (direcciones PÚBLICAS). Solo lee — nunca firma ni mueve nada.
//
// Qué SÍ hace (mejor que la v1 vía OpenSea):
//  · precio real de cada mint (value de la tx), no "coste 0"
//  · GAS de cada compra/venta/mint (fee de la tx)
//  · precio de venta = suma de pagos (WETH/USDG/ETH) al vendedor; compra = lo que
//    pagó el comprador (incluye fees y royalties que salieron de su bolsillo)
// Límites: P&L en ETH y $ al cambio de HOY (no histórico) · floor actual desde
// OpenSea (endpoint de colección, no limitado) · ventas fuera de un marketplace
// on-chain estándar salen como "movido".

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT } from "./lib/data.mjs";
import { loadWallets } from "./lib/wallets.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(ROOT, "data", "trades.json");
const asJson = process.argv.includes("--json");
const log = (...a) => console.error(...a);

(() => { // scripts/.env
  const p = join(HERE, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, "");
  }
})();

const BS_KEY = process.env.BLOCKSCOUT_API_KEY;
if (!BS_KEY) { console.error("Falta BLOCKSCOUT_API_KEY en scripts/.env (ver SETUP.md)."); process.exit(1); }
const OS_KEY = process.env.OPENSEA_API_KEY || "";

const CHAINS = [
  { key: "robinhood", id: 4663 },
  { key: "ethereum", id: 1 },
  { key: "ink", id: 57073 },
];
const ZERO = "0x0000000000000000000000000000000000000000";
const STABLE = /^(USDG|USDC|USDC\.E|USDT|USD₮0|DAI|USDB|USDB\.E)$/i;
const ETHLIKE = /^(W?ETH)$/i;
const SALE_METHODS = /order|fulfill|match|swap|trade|buy|accept|purchase/i;

const wallets = loadWallets();
if (!wallets.length) { console.error("No hay wallets en data/wallets.json."); process.exit(1); }
const own = new Set(wallets.map((w) => w.address.toLowerCase()));
const labelOf = (a) => wallets.find((w) => w.address.toLowerCase() === String(a).toLowerCase())?.label || null;

let apiErrors = 0;
// Blockscout PRO free limita req/s: como mucho 3 en vuelo, con un hueco mínimo
let inFlight = 0;
const waiters = [];
const acquire = () => new Promise((res) => { if (inFlight < 3) { inFlight++; res(); } else waiters.push(res); });
const release = () => { inFlight--; const w = waiters.shift(); if (w) { inFlight++; setTimeout(w, 120); } };
async function bs(chainId, path, params = {}) {
  await acquire();
  try {
    const u = new URL(`https://api.blockscout.com/${chainId}/api/v2${path}`);
    for (const [k, v] of Object.entries({ ...params, apikey: BS_KEY })) if (v != null) u.searchParams.set(k, v);
    for (let retry = 0; retry < 5; retry++) {
      try {
        const r = await fetch(u, { headers: { accept: "application/json" } });
        if (r.status === 429 || r.status === 402) { await new Promise((x) => setTimeout(x, 1500 * 2 ** retry)); continue; }
        if (!r.ok) { apiErrors++; return null; }
        return await r.json();
      } catch (e) { log(`  Blockscout: ${e.message}`); await new Promise((x) => setTimeout(x, 1500)); }
    }
    apiErrors++;
    return null;
  } finally { release(); }
}

async function ethUsd() {
  try {
    const j = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd").then((r) => r.json());
    return j.ethereum.usd;
  } catch { return 2500; }
}

// paginador genérico de Blockscout (listas /addresses/{a}/...)
let truncated = false;
async function bsList(chainId, path, baseParams, mapFn, maxPages = 40) {
  const out = [];
  let params = { ...baseParams };
  for (let page = 0; page < maxPages; page++) {
    const j = await bs(chainId, path, params);
    if (!j) break;
    for (const it of j.items || []) { const v = mapFn(it); if (v) out.push(v); }
    if (!j.next_page_params) break;
    params = j.next_page_params;
    if (page === maxPages - 1) truncated = true;
  }
  return out;
}

// --- 1a) transferencias de NFT de una wallet ---
const nftTransfers = (chainId, address) => bsList(chainId, `/addresses/${address}/token-transfers`,
  { type: "ERC-721,ERC-1155" }, (it) => ({
    contract: (it.token?.address_hash || it.token?.address || "").toLowerCase(),
    tokenId: it.total?.token_id ?? it.total?.id ?? null,
    from: (it.from?.hash || "").toLowerCase(),
    to: (it.to?.hash || "").toLowerCase(),
    ts: Date.parse(it.timestamp) || null,
    tx: it.transaction_hash,
    method: it.method || null,
    name: it.token?.name || null,
    logIndex: it.log_index,
  }));

// --- 1b) TODOS los pagos ERC-20 (WETH/USDG) de una wallet -> por tx ---
const erc20Transfers = (chainId, address) => bsList(chainId, `/addresses/${address}/token-transfers`,
  { type: "ERC-20" }, (it) => {
    const sym = it.token?.symbol || "";
    const kind = ETHLIKE.test(sym) ? "eth" : STABLE.test(sym) ? "usd" : null;
    if (!kind) return null;
    const dec = Number(it.token?.decimals) || 18;
    const amt = Number(it.total?.value) / 10 ** dec;
    if (!amt) return null;
    return { tx: it.transaction_hash, kind, amt, from: (it.from?.hash || "").toLowerCase(), to: (it.to?.hash || "").toLowerCase() };
  });

// --- 1c) txs QUE ENVIÓ la wallet -> gas y valor nativo, por tx ---
const sentTxs = (chainId, address) => bsList(chainId, `/addresses/${address}/transactions`,
  { filter: "from" }, (it) => ({
    tx: it.hash,
    gasEth: (Number(it.fee?.value) || 0) / 1e18,
    nativeEth: (Number(it.value) || 0) / 1e18,
  }), 30);

// suma de pagos eth/usd que salen de / entran a `party` en una tx
function payTotals(pays, party, dir) {
  let eth = 0, usd = 0;
  for (const p of pays || []) {
    if (dir === "out" && p.from !== party) continue;
    if (dir === "in" && p.to !== party) continue;
    if (p.kind === "eth") eth += p.amt; else usd += p.amt;
  }
  return { eth, usd };
}

// --- 2) análisis del pago de una tx (solo para el fallback de floor) ---
const txCache = new Map();
async function analyzeTx(chainId, hash) {
  const ck = chainId + ":" + hash;
  if (txCache.has(ck)) return txCache.get(ck);
  const tt = await bs(chainId, `/transactions/${hash}/token-transfers`);
  const pays = [];
  for (const x of tt?.items || []) {
    if (x.token?.type !== "ERC-20") continue;
    const sym = x.token.symbol || "";
    const dec = Number(x.token.decimals) || 18;
    const amt = Number(x.total?.value) / 10 ** dec;
    if (!amt) continue;
    const kind = ETHLIKE.test(sym) ? "eth" : STABLE.test(sym) ? "usd" : null;
    if (!kind) continue;
    pays.push({ kind, amt, from: (x.from?.hash || "").toLowerCase(), to: (x.to?.hash || "").toLowerCase() });
  }
  const rec = { pays };
  txCache.set(ck, rec);
  return rec;
}

// valor de mercado on-chain (fallback del floor): el MÍNIMO de las últimas ~5
// ventas reales de la colección, leído de Blockscout. Sin marketplace, sin límite.
async function marketFromSales(chainId, contract, rate) {
  const j = await bs(chainId, `/tokens/${contract}/transfers`);
  const items = j?.items || [];
  const txs = [];
  const seen = new Set();
  for (const it of items) {
    const h = it.transaction_hash;
    if (!h || seen.has(h) || it.from?.hash === ZERO) continue; // saltamos mints
    seen.add(h); txs.push(h);
    if (txs.length >= 25) break;
  }
  const prices = [];
  let scanned = 0;
  for (const h of txs) {
    scanned++;
    if (scanned > 12 || (scanned >= 6 && !prices.length)) break;   // colección sin ventas -> no insistir
    const t = await analyzeTx(chainId, h);
    if (!t?.pays?.length) continue;                       // sin pago -> transfer/regalo
    let eth = 0, usd = 0;
    for (const p of t.pays) { if (p.kind === "eth") eth += p.amt; else usd += p.amt; }
    const priceEth = eth + (usd ? usd / rate : 0);
    if (priceEth > 0) prices.push(priceEth);
    if (prices.length >= 5) break;
  }
  if (!prices.length) return null;
  const eth = Math.min(...prices.slice(0, 5));
  return { eth, usd: eth * rate, n: prices.length };
}

async function main() {
  const rate = await ethUsd();
  log(`ETH ≈ $${rate}  ·  ${wallets.length} wallet(s)  ·  Blockscout PRO`);

  // 1) datos en bloque por wallet/red (3 listas paginadas, sin llamadas por-tx):
  //    NFT transfers · pagos ERC-20 (por tx) · gas/valor de las txs que envió la wallet
  const evs = [];
  const payByTx = new Map();   // "chain:tx" -> [{kind,amt,from,to}]
  const sentByTx = new Map();  // "chain:tx" -> {gasEth, nativeEth}  (tx enviada por la wallet)
  for (const w of wallets) {
    const a = w.address.toLowerCase();
    for (const ch of CHAINS) {
      const [nft, erc20, sent] = await Promise.all([
        nftTransfers(ch.id, a), erc20Transfers(ch.id, a), sentTxs(ch.id, a),
      ]);
      for (const e of nft) { e.chain = ch.key; e.chainId = ch.id; }
      evs.push(...nft);
      for (const p of erc20) {
        const k = `${ch.key}:${p.tx}`;
        if (!payByTx.has(k)) payByTx.set(k, []);
        payByTx.get(k).push(p);
      }
      for (const s of sent) sentByTx.set(`${ch.key}:${s.tx}`, s);
      log(`  ${w.label}/${ch.key}: ${nft.length} NFT · ${erc20.length} pagos · ${sent.length} txs`);
    }
  }
  if (!evs.length && apiErrors) {
    console.error("\n⚠️ Blockscout no respondió. NO se toca data/trades.json. Reintenta en unos minutos.");
    process.exit(2);
  }

  // dedupe de transferencias NFT
  const seen = new Set();
  const events = evs.filter((e) => {
    const k = `${e.chain}:${e.tx}:${e.contract}:${e.tokenId}:${e.from}:${e.to}:${e.logIndex}`;
    if (seen.has(k)) return false; seen.add(k); return true;
  });
  const pays = (chain, tx) => payByTx.get(`${chain}:${tx}`) || [];
  const sent = (chain, tx) => sentByTx.get(`${chain}:${tx}`) || null;

  // 2) agrupar por NFT y emparejar (FIFO)
  const byNft = new Map();
  for (const e of events) {
    if (e.tokenId == null) continue;
    const k = `${e.chain}:${e.contract}:${e.tokenId}`;
    if (!byNft.has(k)) byNft.set(k, []);
    byNft.get(k).push(e);
  }

  const positions = [];
  const heldContracts = new Set();

  for (const [, list] of byNft) {
    list.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    const lots = [];
    const info = list.find((e) => e.name) || list[0];

    for (const e of list) {
      const acq = own.has(e.to) && !own.has(e.from);
      const dis = own.has(e.from) && !own.has(e.to);
      if (own.has(e.to) && own.has(e.from)) continue; // interno

      const P = pays(e.chain, e.tx);
      const S = sent(e.chain, e.tx);      // esta tx la envió una de mis wallets?

      if (acq) {
        const isMint = e.from === ZERO;
        const buyer = e.to;
        let priceEth = 0, priceUsd = 0;
        if (isMint) {
          if (S) priceEth = S.nativeEth;          // el precio del mint = ETH nativo que mandé
        } else {
          const out = payTotals(P, buyer, "out"); // compra: todo lo que salió de mi bolsillo (+fees/royalty)
          priceEth = out.eth; priceUsd = out.usd;
          if (S && S.nativeEth) priceEth += S.nativeEth;
        }
        const gasEth = S ? S.gasEth : 0;
        const costEth = priceEth + (priceUsd ? priceUsd / rate : 0) + gasEth;
        const paid = priceEth > 0 || priceUsd > 0;
        lots.push({
          ts: e.ts, kind: isMint ? "mint" : paid ? "buy" : "transfer_in",
          costEth, gasEth, tx: e.tx, wallet: labelOf(e.to),
          flags: isMint && !paid ? ["free_mint"] : (!isMint && !paid) ? ["cost_unknown"] : [],
        });
      } else if (dis) {
        const seller = e.from;
        const inc = payTotals(P, seller, "in");
        const isSale = (inc.eth + inc.usd) > 0;
        const gasEth = S ? S.gasEth : 0;
        const procEth = isSale ? (inc.eth + (inc.usd ? inc.usd / rate : 0)) - gasEth : null;
        const lot = lots.shift() || { ts: null, kind: "unknown", costEth: null, gasEth: 0, flags: ["no_acq"] };
        positions.push({
          chain: e.chain, contract: info.contract, tokenId: info.tokenId,
          wallet: lot.wallet || labelOf(e.from),
          name: info.name ? `${info.name} #${info.tokenId}` : `#${info.tokenId}`,
          url: `https://opensea.io/assets/${e.chain}/${info.contract}/${info.tokenId}`,
          acquired: lot.ts ? { ts: lot.ts, type: lot.kind, priceEth: lot.costEth, gasEth: lot.gasEth, tx: lot.tx } : null,
          disposed: { ts: e.ts, type: isSale ? "sale" : "transfer_out", priceEth: isSale ? procEth : null, gasEth, tx: e.tx },
          status: isSale ? "sold" : "moved_out",
          realizedEth: (isSale && lot.costEth != null) ? +(procEth - lot.costEth).toFixed(6) : null,
          flags: [...new Set([...(lot.flags || []), ...(isSale ? [] : ["sold_elsewhere_or_gift"])])],
        });
      }
    }
    for (const lot of lots) {
      heldContracts.add(`${info.chain}|${info.contract}`);
      positions.push({
        chain: info.chain, contract: info.contract, tokenId: info.tokenId,
        wallet: lot.wallet || null,
        name: info.name ? `${info.name} #${info.tokenId}` : `#${info.tokenId}`,
        url: `https://opensea.io/assets/${info.chain}/${info.contract}/${info.tokenId}`,
        acquired: { ts: lot.ts, type: lot.kind, priceEth: lot.costEth, gasEth: lot.gasEth, tx: lot.tx },
        disposed: null, status: "held", realizedEth: null,
        flags: lot.flags || [],
      });
    }
  }

  // 3) valor de mercado por colección: caché en disco + floor de OpenSea + fallback
  //    on-chain (mín. de las últimas ~5 ventas). Prioriza las colecciones donde
  //    más NFTs tienes (el valor de un farmeador está en sus posiciones grandes).
  const chainIdOf = Object.fromEntries(CHAINS.map((c) => [c.key, c.id]));
  const heldCount = new Map();
  for (const p of positions) if (p.status === "held") {
    const k = `${p.chain}|${p.contract}`;
    heldCount.set(k, (heldCount.get(k) || 0) + 1);
  }
  const FLOOR_CACHE = join(ROOT, "data", "floor-cache.json");
  const FLOOR_TTL = 6 * 3600 * 1000;
  let fCache = {};
  try { fCache = JSON.parse(readFileSync(FLOOR_CACHE, "utf8")); } catch { /**/ }
  const floors = {};
  const now = Date.now();
  for (const [k, v] of Object.entries(fCache)) {
    if (now - (v.at || 0) < FLOOR_TTL) { const c = k.split("|")[1]; floors[c] = v; }
  }
  // priorizamos: colecciones donde tienes >1, o por las que pagaste algo, o vendidas
  // 1º las colecciones que importan de verdad (compraste / vendiste), 2º donde
  // tienes muchas. Tope 50.
  const paidC = new Set(positions.filter((p) => (p.acquired?.priceEth || 0) > 0.0004 || p.status === "sold").map((p) => `${p.chain}|${p.contract}`));
  const bigHeld = [...heldCount.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const heldList = [...new Set([...paidC, ...bigHeld])]
    .slice(0, 50)
    .map((hc) => { const [chain, contract] = hc.split("|"); return { chain, contract, n: heldCount.get(hc) || 0, paid: paidC.has(hc) }; })
    .filter(({ contract }) => !floors[contract]);   // lo que ya está en caché fresca no se re-pide

  if (OS_KEY && heldList.length) {
    const H = { headers: { "x-api-key": OS_KEY, accept: "application/json" } };
    // devuelve {ok, body}. OpenSea es solo una MEJORA (el fallback on-chain cubre
    // el resto), así que si va lento no insistimos: 1 reintento corto y a otra cosa.
    let osDown = false;
    const osGet = async (url) => {
      if (osDown) return { ok: false, body: null };
      for (let i = 0; i < 2; i++) {
        const r = await fetch(url, H).catch(() => null);
        if (r && r.ok) return { ok: true, body: await r.json() };
        if (r && r.status === 404) return { ok: true, body: null };
        if (r && (r.status === 429 || r.status === 401)) {
          if (i) { osDown = true; return { ok: false, body: null }; }  // 2º 429 -> OpenSea saturada, dejamos de intentar
          await new Promise((x) => setTimeout(x, 800));
          continue;
        }
        return { ok: false, body: null };
      }
      return { ok: false, body: null };
    };
    let csCache = {};
    const csPath = join(ROOT, "data", "contract-slugs.json");
    try { csCache = JSON.parse(readFileSync(csPath, "utf8")); } catch { /**/ }
    let csWrote = false;
    for (const { chain, contract } of heldList) {
      let slug = csCache[contract];
      if (slug === undefined) {
        const res = await osGet(`https://api.opensea.io/api/v2/chain/${chain}/contract/${contract}`);
        slug = res.body?.collection || null;
        if (slug && /^0x[0-9a-f]{6,}/i.test(slug)) slug = null; // OpenSea devuelve a veces el contrato como slug
        if (res.ok) { csCache[contract] = slug; csWrote = true; }   // solo cacheamos una respuesta real
        await new Promise((x) => setTimeout(x, 150));
      }
      if (!slug) continue;
      const res = await osGet(`https://api.opensea.io/api/v2/collections/${slug}/stats`);
      const tt = res.body?.total || {};
      if (tt.floor_price == null) continue;
      const sym = tt.floor_price_symbol || "ETH";
      floors[contract] = STABLE.test(sym)
        ? { eth: tt.floor_price / rate, usd: tt.floor_price, src: "opensea", at: Date.now() }
        : { eth: tt.floor_price, usd: tt.floor_price * rate, src: "opensea", at: Date.now() };
      await new Promise((x) => setTimeout(x, 90));
    }
    if (csWrote) { try { writeFileSync(csPath, JSON.stringify(csCache, null, 1) + "\n"); } catch { /**/ } }
  }

  // fallback on-chain (últimas ventas) para lo que OpenSea no dio; los paid primero
  let mkCalls = 0;
  for (const { chain, contract, n, paid } of [...heldList].sort((a, b) => (b.paid ? 1 : 0) - (a.paid ? 1 : 0))) {
    if (floors[contract]) continue;
    if (!paid && n < 5) { floors[contract] = { eth: 0, usd: 0, src: "none", at: Date.now() }; continue; }
    if (!paid && mkCalls++ >= 20) { floors[contract] = { eth: 0, usd: 0, src: "none", at: Date.now() }; continue; }
    const mk = await marketFromSales(chainIdOf[chain], contract, rate).catch(() => null);
    floors[contract] = mk
      ? { eth: mk.eth, usd: mk.usd, src: "sales" + mk.n, at: Date.now() }
      : { eth: 0, usd: 0, src: "none", at: Date.now() };   // cacheamos "sin mercado" para no reintentar
    if (mk) log(`  ~mercado ${contract.slice(0, 10)}: ${mk.eth.toFixed(5)} ETH (min de ${mk.n} ventas)`);
  }

  // guardar caché (keyed por chain|contract, conservando lo viejo aún dentro de TTL)
  const cacheOut = {};
  for (const [k, v] of Object.entries(fCache)) if (now - (v.at || 0) < FLOOR_TTL) cacheOut[k] = v;
  for (const k of heldCount.keys()) { const c = k.split("|")[1]; if (floors[c]) cacheOut[k] = floors[c]; }
  try { writeFileSync(FLOOR_CACHE, JSON.stringify(cacheOut, null, 0) + "\n"); } catch { /**/ }

  for (const p of positions) {
    const f = floors[p.contract];
    if (!f || !(f.eth > 0)) continue;         // "none" = valor desconocido, NO 0
    p.floorEth = f.eth; p.floorUsd = f.usd; p.floorSrc = f.src;
    // P&L no realizado si conoces un coste real (compra o mint de pago >~$0.25)
    if (p.status === "held" && p.acquired && p.acquired.priceEth > 1e-4) {
      p.unrealizedEth = +(f.eth - p.acquired.priceEth).toFixed(6);
    }
  }

  // 4) resumen
  const sold = positions.filter((p) => p.status === "sold");
  const held = positions.filter((p) => p.status === "held");
  const sum = (arr, k) => arr.reduce((a, x) => a + (x[k] || 0), 0);
  const gasTotal = positions.reduce((a, p) => a + (p.acquired?.gasEth || 0) + (p.disposed?.gasEth || 0), 0);
  const summary = {
    realizedEth: +sum(sold, "realizedEth").toFixed(4),
    realizedUsd: +(sum(sold, "realizedEth") * rate).toFixed(2),
    unrealizedEth: +sum(held, "unrealizedEth").toFixed(4),
    heldFloorEth: +sum(held, "floorEth").toFixed(4),
    gasEth: +gasTotal.toFixed(4),
    sold: sold.length,
    held: held.length,
    wins: sold.filter((p) => (p.realizedEth || 0) > 0).length,
    losses: sold.filter((p) => (p.realizedEth || 0) < 0).length,
    movedOut: positions.filter((p) => p.status === "moved_out").length,
  };

  const payload = {
    updated: new Date().toISOString(),
    ethUsd: rate,
    source: "blockscout",
    truncated,
    wallets: wallets.map((w) => ({ label: w.label, address: w.address })),
    positions: positions.sort((a, b) => (b.disposed?.ts || b.acquired?.ts || 0) - (a.disposed?.ts || a.acquired?.ts || 0)),
    summary,
  };
  if (!positions.length && apiErrors) {
    console.error("\n⚠️ Blockscout falló durante el análisis. NO se toca data/trades.json.");
    process.exit(2);
  }
  writeFileSync(OUT, JSON.stringify(payload, null, 2) + "\n");
  log(`\n✔ ${OUT}`);
  log(`  vendidos ${sold.length} (${summary.wins}✅/${summary.losses}❌) · realizado ${summary.realizedEth} ETH ($${summary.realizedUsd})`);
  log(`  en cartera ${held.length} · no realizado ${summary.unrealizedEth} ETH · valor floor ${summary.heldFloorEth} ETH`);
  log(`  gas total ${summary.gasEth} ETH · movidos fuera ${summary.movedOut}`);
  if (asJson) process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
}

main().catch((e) => { console.error("fetch-trades:", e.message); process.exit(1); });
