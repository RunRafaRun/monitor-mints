// Cartera / P&L: reconstruye compras y ventas de NFT de tus wallets (RobinHood,
// Ethereum, Ink) leyendo la API de eventos de OpenSea. Sin nada a mano.
//
//   node fetch-trades.mjs           -> data/trades.json  (lo lee el dashboard)
//   node fetch-trades.mjs --json    además vuelca el resultado por stdout
//
// Necesita OPENSEA_API_KEY en scripts/.env y data/wallets.json (direcciones
// PÚBLICAS). Solo lee — nunca firma ni mueve nada.
//
// LÍMITES v1:  no incluye gas · mints = coste 0 (marcado) · P&L en ETH + $ al
// cambio de HOY (no histórico) · ventas fuera de OpenSea (Blur…) salen como
// "movido" sin precio.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT } from "./lib/data.mjs";
import { loadWallets } from "./lib/wallets.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(ROOT, "data", "trades.json");
const CHAINS = new Set(["robinhood", "ethereum", "ink"]);
const STABLE = /^(USDG|USDC|USDT|DAI|USDB)$/i;
const MAX_PAGES = 14;         // ~700 eventos por tipo y wallet
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

const KEY = process.env.OPENSEA_API_KEY;
if (!KEY) { console.error("Falta OPENSEA_API_KEY en scripts/.env (ver SETUP.md)."); process.exit(1); }
const H = { headers: { "x-api-key": KEY, accept: "application/json" } };

const wallets = loadWallets();
if (!wallets.length) { console.error("No hay wallets en data/wallets.json."); process.exit(1); }
const own = new Set(wallets.map((w) => w.address.toLowerCase()));
const labelOf = (addr) => wallets.find((w) => w.address.toLowerCase() === String(addr).toLowerCase())?.label || null;

async function ethUsd() {
  try {
    const j = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd").then((r) => r.json());
    return j.ethereum.usd;
  } catch { return 2400; }
}

// { eth, usd } normalizado desde payment {quantity,decimals,symbol}
function money(payment, rate) {
  if (!payment || payment.quantity == null) return { eth: null, usd: null, sym: null };
  const dec = payment.decimals ?? 18;
  const amt = Number(payment.quantity) / 10 ** dec;
  const sym = payment.symbol || null;
  if (sym && STABLE.test(sym)) return { eth: rate ? amt / rate : null, usd: amt, sym };
  return { eth: amt, usd: rate ? amt * rate : null, sym: sym || "ETH" }; // ETH/WETH/otros 18d
}

let apiErrors = 0;
async function eventsFor(address, kind) {
  const out = [];
  let cursor = null, hadError = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const u = new URL(`https://api.opensea.io/api/v2/events/accounts/${address}`);
    u.searchParams.set("event_type", kind);
    u.searchParams.set("limit", "50");
    if (cursor) u.searchParams.set("next", cursor);
    let j, ok = false;
    for (let retry = 0; retry < 4 && !ok; retry++) {
      try {
        const r = await fetch(u, H);
        // OpenSea limita la API de eventos y a veces devuelve 401 en vez de 429
        if (r.status === 401 || r.status === 429) {
          const wait = 2000 * 2 ** retry;
          log(`  events ${kind}: HTTP ${r.status}, reintento en ${wait / 1000}s`);
          await new Promise((res) => setTimeout(res, wait));
          continue;
        }
        if (!r.ok) { log(`  events ${kind} ${address.slice(0, 8)}: HTTP ${r.status}`); hadError = true; break; }
        j = await r.json(); ok = true;
      } catch (e) { log(`  events ${kind}: ${e.message}`); await new Promise((res) => setTimeout(res, 1500)); }
    }
    if (!ok) { hadError = true; break; }
    for (const ev of j.asset_events || []) if (CHAINS.has(ev.chain)) out.push(ev);
    cursor = j.next || null;
    if (!cursor) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  if (hadError) apiErrors++;
  return { events: out, truncated: out.length >= MAX_PAGES * 50 };
}

const nftKey = (ev) => `${ev.chain}:${(ev.nft?.contract || "").toLowerCase()}:${ev.nft?.identifier}`;

async function main() {
  const rate = await ethUsd();
  log(`ETH ≈ $${rate}  ·  ${wallets.length} wallet(s)`);

  // 1) recoger eventos (ventas + transfers) de todas las wallets
  const all = [];
  let truncated = false;
  for (const w of wallets) {
    for (const kind of ["sale", "transfer"]) {
      const { events, truncated: tr } = await eventsFor(w.address, kind);
      truncated ||= tr;
      all.push(...events);
      log(`  ${w.label}/${kind}: ${events.length}`);
    }
  }

  // si la API falló y no tenemos NADA, no pisamos el trades.json bueno que ya haya
  if (!all.length && apiErrors) {
    console.error(`\n⚠️ La API de eventos de OpenSea no respondió (${apiErrors} error/es; suele ser`);
    console.error(`   límite temporal del plan free). NO se toca data/trades.json. Reintenta en unos minutos.`);
    process.exit(2);
  }

  // 2a) la API repite eventos idénticos y los devuelve una vez por wallet -> únicos
  const uniq = new Map();
  for (const e of all) {
    const id = `${e.event_type}:${e.transaction}:${nftKey(e)}:${e.event_timestamp}:${(e.seller || e.from_address || "")}:${(e.buyer || e.to_address || "")}`;
    if (!uniq.has(id)) uniq.set(id, e);
  }
  // 2b) una venta trae también un transfer con el mismo tx -> nos quedamos con la venta
  const deduped = [...uniq.values()];
  const saleTx = new Set(deduped.filter((e) => e.event_type === "sale").map((e) => `${e.transaction}:${nftKey(e)}`));
  const events = deduped.filter((e) => e.event_type !== "transfer" || !saleTx.has(`${e.transaction}:${nftKey(e)}`));

  // 3) por NFT (contrato+id): ordenar por tiempo y emparejar compras con ventas (FIFO)
  const byNft = new Map();
  for (const ev of events) {
    if (!ev.nft?.identifier) continue;
    const k = nftKey(ev);
    if (!byNft.has(k)) byNft.set(k, []);
    byNft.get(k).push(ev);
  }
  const positions = [];
  const heldSlugs = new Set();

  for (const [key, evs] of byNft) {
    evs.sort((a, b) => a.event_timestamp - b.event_timestamp);
    const lots = []; // compras abiertas
    const nftInfo = evs.find((e) => e.nft?.name)?.nft || evs[0].nft;
    const [chain] = key.split(":");

    for (const ev of evs) {
      const isSale = ev.event_type === "sale";
      const to = (ev.buyer || ev.to_address || "").toLowerCase();
      const from = (ev.seller || ev.from_address || "").toLowerCase();
      const acq = to && own.has(to) && !(from && own.has(from));      // entra de fuera
      const dis = from && own.has(from) && !(to && own.has(to));      // sale hacia fuera
      const internal = to && from && own.has(to) && own.has(from) && ev.transfer_type !== "mint";
      if (internal) continue;

      if (acq || (ev.transfer_type === "mint")) {
        const m = isSale ? money(ev.payment, rate) : { eth: 0, usd: 0, sym: null };
        lots.push({
          ts: ev.event_timestamp,
          kind: ev.transfer_type === "mint" ? "mint" : isSale ? "buy" : "transfer_in",
          costEth: ev.transfer_type === "mint" ? 0 : m.eth,
          costUsd: ev.transfer_type === "mint" ? 0 : m.usd,
          costSym: m.sym,
          tx: ev.transaction,
          wallet: labelOf(to),
          flags: ev.transfer_type === "mint" ? ["mint"] : (!isSale ? ["cost_unknown"] : []),
        });
      } else if (dis) {
        const m = isSale ? money(ev.payment, rate) : { eth: null, usd: null, sym: null };
        const lot = lots.shift() || { ts: null, kind: "unknown", costEth: null, costUsd: null, flags: ["no_acq"] };
        positions.push({
          chain,
          contract: nftInfo.contract, tokenId: nftInfo.identifier,
          collection: nftInfo.collection || null,
          name: nftInfo.name || `#${nftInfo.identifier}`,
          image: nftInfo.display_image_url || nftInfo.image_url || null,
          url: nftInfo.opensea_url || null,
          acquired: lot.ts ? { ts: lot.ts, type: lot.kind, priceEth: lot.costEth, priceUsd: lot.costUsd, tx: lot.tx } : null,
          disposed: { ts: ev.event_timestamp, type: isSale ? "sale" : "transfer_out", priceEth: m.eth, priceUsd: m.usd, tx: ev.transaction },
          status: isSale ? "sold" : "moved_out",
          realizedEth: (isSale && lot.costEth != null && m.eth != null) ? +(m.eth - lot.costEth).toFixed(6) : null,
          realizedUsd: (isSale && lot.costUsd != null && m.usd != null) ? +(m.usd - lot.costUsd).toFixed(2) : null,
          flags: [...new Set([...(lot.flags || []), ...(isSale ? [] : ["sold_elsewhere_or_gift"])])],
        });
      }
    }
    // lo que queda en 'lots' -> en cartera
    for (const lot of lots) {
      if (nftInfo.collection) heldSlugs.add(`${chain}|${nftInfo.collection}`);
      positions.push({
        chain,
        contract: nftInfo.contract, tokenId: nftInfo.identifier,
        collection: nftInfo.collection || null,
        name: nftInfo.name || `#${nftInfo.identifier}`,
        image: nftInfo.display_image_url || nftInfo.image_url || null,
        url: nftInfo.opensea_url || null,
        acquired: { ts: lot.ts, type: lot.kind, priceEth: lot.costEth, priceUsd: lot.costUsd, tx: lot.tx },
        disposed: null,
        status: "held",
        realizedEth: null, realizedUsd: null,
        flags: lot.flags || [],
      });
    }
  }

  // 4) floor actual de las colecciones que sigo teniendo (para el no-realizado)
  const floors = {};
  const slugList = [...heldSlugs].map((s) => s.split("|")[1]).filter(Boolean);
  for (const slug of [...new Set(slugList)].slice(0, 50)) {
    try {
      const r = await fetch(`https://api.opensea.io/api/v2/collections/${slug}/stats`, H);
      if (!r.ok) continue;
      const tt = (await r.json())?.total || {};
      if (tt.floor_price == null) continue;
      const sym = tt.floor_price_symbol || "ETH";
      floors[slug] = STABLE.test(sym)
        ? { eth: rate ? tt.floor_price / rate : null, usd: tt.floor_price, sym }
        : { eth: tt.floor_price, usd: rate ? tt.floor_price * rate : null, sym };
    } catch { /* nada */ }
    await new Promise((r) => setTimeout(r, 90));
  }
  for (const p of positions) {
    if (p.status !== "held" || !p.collection) continue;
    const f = floors[p.collection];
    if (!f) continue;
    p.floorEth = f.eth; p.floorUsd = f.usd;
    // P&L no realizado SOLO en lo que compraste (los mints gratis no tienen coste base)
    if (p.acquired?.type === "buy" && p.acquired.priceEth != null && f.eth != null) {
      p.unrealizedEth = +(f.eth - p.acquired.priceEth).toFixed(6);
    }
  }

  // 5) resumen
  const sold = positions.filter((p) => p.status === "sold");
  const held = positions.filter((p) => p.status === "held");
  const sum = (arr, k) => arr.reduce((a, x) => a + (x[k] || 0), 0);
  const summary = {
    realizedEth: +sum(sold, "realizedEth").toFixed(4),
    realizedUsd: +sum(sold, "realizedUsd").toFixed(2),
    unrealizedEth: +sum(held, "unrealizedEth").toFixed(4),          // solo compras
    heldFloorEth: +sum(held, "floorEth").toFixed(4),                // valor a floor de TODO lo que tienes
    sold: sold.length,
    held: held.length,
    wins: sold.filter((p) => (p.realizedEth || 0) > 0).length,
    losses: sold.filter((p) => (p.realizedEth || 0) < 0).length,
    movedOut: positions.filter((p) => p.status === "moved_out").length,
  };

  const payload = {
    updated: new Date().toISOString(),
    ethUsd: rate,
    wallets: wallets.map((w) => ({ label: w.label, address: w.address })),
    truncated,
    positions: positions.sort((a, b) => (b.disposed?.ts || b.acquired?.ts || 0) - (a.disposed?.ts || a.acquired?.ts || 0)),
    summary,
  };
  writeFileSync(OUT, JSON.stringify(payload, null, 2) + "\n");
  log(`\n✔ ${OUT}`);
  log(`  vendidos ${sold.length} (${summary.wins}✅/${summary.losses}❌)  ·  realizado ${summary.realizedEth} ETH ($${summary.realizedUsd})`);
  log(`  en cartera ${held.length}  ·  no realizado ${summary.unrealizedEth} ETH  ·  movidos fuera ${summary.movedOut}`);
  if (truncated) log("  ⚠️ historial largo: puede faltar lo más antiguo (límite de páginas)");
  if (asJson) process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
}

main().catch((e) => { console.error("fetch-trades:", e.message); process.exit(1); });
