// Cloudflare Pages Function — revisa los veredictos que guardó analyze.js una vez
// ha pasado tiempo suficiente desde el mint, para saber si acertamos o no.
//
//   GET|POST /api/review-predictions[?dry=1]
//   -> { checked, reviewed, results:[{name,verdict,outcome,ratio}], pending, total }
//
// Pensado para llamarse solo (cron): el GitHub Action de build.yml lo invoca en
// cada pasada (cada ~10 min). No hace falta tocar nada a mano.
//
// Requiere el binding KV "PREDICTIONS" (mismo que usa analyze.js para guardar) y,
// para volver a mirar el floor actual, OPENSEA_API_KEY. Sin el binding KV, 503.
//
// Criterio de revisión: solo se revisan predicciones con "when" (fecha de mint)
// al menos 3 días en el pasado (o, si no se conocía, 5 días desde que se generó
// el veredicto) y que no se hayan revisado ya. Compara el floor actual (USD)
// contra el precio público (USD) que tenía en el momento del veredicto:
//   EVITAR/DUDOSO  -> "correct" si el floor acabó por debajo del precio público
//   VALE_LA_PENA   -> "correct" si el floor se mantuvo igual o por encima
// Los mints gratis (precio 0) no se pueden juzgar así -> "unclear".

const GRACE_AFTER_MINT_MS = 3 * 24 * 3600e3;
const GRACE_NO_DATE_MS = 5 * 24 * 3600e3;

async function handle({ env, request }) {
  if (!env.PREDICTIONS) return j({ error: "not_configured" }, 503);
  const params = new URL(request.url).searchParams;
  const dry = params.get("dry") === "1";
  if (params.get("stats") === "1") return statsReport(env);

  const ethUsd = await fetchEthUsd().catch(() => null);
  const list = await env.PREDICTIONS.list({ prefix: "pred:" });
  const now = Date.now();
  let reviewed = 0;
  const results = [];
  let pending = 0;

  for (const { name: key } of list.keys) {
    const raw = await env.PREDICTIONS.get(key);
    if (!raw) continue;
    let rec;
    try { rec = JSON.parse(raw); } catch { continue; }
    if (rec.outcome) continue; // ya revisado

    const dueAt = rec.when ? rec.when + GRACE_AFTER_MINT_MS : Date.parse(rec.predictedAt) + GRACE_NO_DATE_MS;
    if (!(now >= dueAt)) { pending++; continue; }
    if (!rec.slug || !ethUsd) { pending++; continue; }

    const floorNow = await fetchFloorUsd(rec.slug, ethUsd, env).catch(() => null);
    if (floorNow == null) { pending++; continue; } // sin mercado todavía -> reintenta más adelante

    let outcome = "unclear", ratio = null;
    if (rec.priceUsd != null && rec.priceUsd > 0) {
      ratio = Math.round((floorNow / rec.priceUsd) * 100) / 100;
      const bad = /EVITAR|DUDOSO/.test(rec.verdict);
      if (bad) outcome = ratio < 1 ? "correct" : ratio >= 1.3 ? "incorrect" : "unclear";
      else outcome = ratio >= 1 ? "correct" : ratio < 0.7 ? "incorrect" : "unclear";
    }
    reviewed++;
    results.push({ name: rec.name, verdict: rec.verdict, outcome, ratio, floorUsdNow: floorNow, priceUsd: rec.priceUsd });
    if (!dry) {
      rec.outcome = outcome; rec.reviewedAt = new Date().toISOString(); rec.floorUsdAtReview = floorNow; rec.ratio = ratio;
      await env.PREDICTIONS.put(key, JSON.stringify(rec));
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  return j({ checked: list.keys.length, reviewed, pending, dry, results });
}

export const onRequestGet = handle;
export const onRequestPost = handle;

// GET /api/review-predictions?stats=1 — histórico de aciertos, sin tocar nada.
async function statsReport(env) {
  const list = await env.PREDICTIONS.list({ prefix: "pred:" });
  const all = [];
  for (const { name: key } of list.keys) {
    const raw = await env.PREDICTIONS.get(key);
    if (raw) { try { all.push(JSON.parse(raw)); } catch {} }
  }
  const done = all.filter((r) => r.outcome);
  const correct = done.filter((r) => r.outcome === "correct").length;
  const incorrect = done.filter((r) => r.outcome === "incorrect").length;
  const unclear = done.filter((r) => r.outcome === "unclear").length;
  return j({
    total: all.length, reviewed: done.length, pendingReview: all.length - done.length,
    correct, incorrect, unclear,
    accuracy: correct + incorrect > 0 ? Math.round((correct / (correct + incorrect)) * 100) + "%" : "n/a",
    predictions: all.sort((a, b) => Date.parse(b.predictedAt) - Date.parse(a.predictedAt)).slice(0, 100),
  });
}

async function fetchEthUsd() {
  const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd");
  const j2 = await r.json();
  return j2?.ethereum?.usd || null;
}

async function fetchFloorUsd(slug, ethUsd, env) {
  if (!env.OPENSEA_API_KEY) return null;
  const r = await fetch(`https://api.opensea.io/api/v2/collections/${encodeURIComponent(slug)}/stats`, {
    headers: { "x-api-key": env.OPENSEA_API_KEY, accept: "application/json" },
  });
  if (!r.ok) return null;
  const st = await r.json();
  const tt = st?.total || {};
  if (tt.floor_price == null) return null;
  const sym = tt.floor_price_symbol || "ETH";
  if (sym === "ETH" || sym === "WETH") return tt.floor_price * ethUsd;
  return tt.floor_price; // stablecoin ~= USD
}

function j(o, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json; charset=utf-8" } });
}
