// Parser del feed público de NFT Trencher (neverfuckingtrade.com).
//
// Fuente: https://cdn.neverfuckingtrade.com/feed.html  — HTML estático (~1 MB), sin
// auth. Cada mint es un <article class="card"> con atributos data-* y una lista de
// "gates" (fases TEAM / GTD / FCFS / WL / HOLDER / PUBLIC).
//
// ⚠️ Es scraping de HTML: si cambian el marcado, hay que ajustar los regex de aquí.
// El feed NO trae los nombres de las colecciones elegibles: eso sigue siendo
// investigación manual (ver docs/metodologia.md).

const FEED_URL = "https://cdn.neverfuckingtrade.com/feed.html";

export async function fetchFeed(chain = "robinhood") {
  const r = await fetch(`${FEED_URL}?v=${Date.now()}`, {
    headers: { "user-agent": "Mozilla/5.0 (Monitor-MINTS)" },
  });
  if (!r.ok) throw new Error(`Trencher feed HTTP ${r.status}`);
  const html = await r.text();
  return parseFeed(html, chain);
}

export function parseFeed(html, chain = "robinhood") {
  const cards = [];
  const parts = html.split(/<article\b/i).slice(1);
  for (const raw of parts) {
    const block = "<article " + raw.split(/<\/article>/i)[0];
    const c = parseCard(block);
    if (c && (!chain || c.chain === chain)) cards.push(c);
  }
  return cards;
}

function attr(s, name) {
  const m = s.match(new RegExp(`data-${name}="([^"]*)"`));
  return m ? m[1] : null;
}

function parseCard(block) {
  const head = block.slice(0, block.indexOf("<div class=\"head\"") + 1 || 1200);
  const chain = attr(head, "chain");
  if (!chain) return null;

  const num = (v) => (v == null || v === "" ? null : Number(v));
  const nameM = block.match(/<h1 class="name[^"]*">([^<]*)<\/h1>/);
  const supplyM =
    block.match(/class="minted">([\d,]+)<\/span><span class="of-max">\/([\d,]+)/) ||
    block.match(/aria-label="Minted ([\d,]+) of ([\d,]+)"/);
  const links = [...block.matchAll(/href="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
  const rateM = block.match(/class="rate">([^<]+)</);

  return {
    name: nameM ? nameM[1].trim() : "(sin nombre)",
    chain,
    contract: attr(head, "addr"),
    startMs: num(attr(head, "start")),
    endMs: num(attr(head, "end")),
    priceEth: num(attr(head, "price")),
    free: attr(head, "free") === "1",
    hype: num(attr(head, "hype")),
    tier: attr(head, "tier"),            // dust | cold | warm | hot
    grade: attr(head, "grade"),
    xFollowers: num(attr(head, "fol")),
    xPosts: num(attr(head, "posts")),
    xAgeDays: num(attr(head, "age")),    // -1 = sin cuenta
    team: attr(head, "team") || null,    // anon | doxxed | ...
    socials: num(attr(head, "social")),
    minted: supplyM ? Number(supplyM[1].replace(/,/g, "")) : null,
    supply: supplyM ? Number(supplyM[2].replace(/,/g, "")) : null,
    mintRate: rateM ? rateM[1].trim() : null,
    x: links.find((u) => /x\.com|twitter\.com/.test(u)) || null,
    opensea: links.find((u) => /opensea\.io/.test(u)) || null,
    openseaSlug: (links.find((u) => /opensea\.io\/collection\//.test(u)) || "")
      .split("/collection/")[1]?.replace(/\/$/, "") || null,
    site: links.find((u) => !/x\.com|twitter\.com|opensea\.io|discord/.test(u)) || null,
    gates: parseGates(block),
    isLive: /class="card[^"]*is-live/.test(block),
  };
}

function parseGates(block) {
  const gates = [];
  const re = /<div class="gate"([\s\S]*?)>\s*<div class="gate-top">([\s\S]*?)<\/div>/g;
  let m;
  while ((m = re.exec(block))) {
    const meta = m[1], top = m[2];
    const title = (meta.match(/title="([^"]*)"/) || [])[1] || "";
    const gname = (top.match(/gate-name">([^<]*)</) || [])[1] || "";
    const gprice = (top.match(/gate-price">([^<]*)</) || [])[1] || "";
    const parts = title.split("·").map((s) => s.trim());
    // los 3 últimos trozos del title son: rango horario · precio · "limit N"
    const tail = parts.slice(-3);
    const limitTxt = tail[2] || "";
    const limitM = limitTxt.match(/limit\s+([\d,]+)/i) || gprice.match(/[×x]\s*([\d,]+)/);
    gates.push({
      label: parts[0] || gname,
      kind: classifyPhase(gname || parts[0] || ""),
      name: gname,
      priceText: gprice,
      when: tail[0] || null,
      price: tail[1] || null,
      limit: limitTxt || null,
      perWallet: limitM ? Number(limitM[1].replace(/,/g, "")) : null,
      state: (meta.match(/data-state="([^"]*)"/) || [])[1] || null,
      startMs: Number((meta.match(/data-start="([^"]*)"/) || [])[1]) || null,
      endMs: Number((meta.match(/data-end="([^"]*)"/) || [])[1]) || null,
    });
  }
  return gates;
}

function classifyPhase(s) {
  const u = s.toUpperCase();
  if (u.includes("FCFS")) return "FCFS";
  if (u.includes("GTD")) return "GTD";
  if (u.includes("TEAM") || u.includes("TREASURY") || u.includes("PARTNER")) return "TEAM";
  if (u.includes("HOLDER")) return "HOLDER";
  if (u.includes("PUBLIC")) return "PUBLIC";
  if (u.includes("WL") || u.includes("ALLOWLIST") || u.includes("WHITELIST")) return "WL";
  return "OTHER";
}

// Veredicto rápido de popularidad a partir de los datos del feed.
export function popularityVerdict(c) {
  const f = c.xFollowers ?? 0, p = c.xPosts ?? 0, age = c.xAgeDays ?? -1;
  const h = c.hype ?? 0;
  if (age < 0 || !c.x) return "🔴 sin X";
  if (f > 6000 && h >= 45 && age > 45) return "🟢 ALTO";
  if (f > 2500 && h >= 30) return "🟢 ALTO";
  if (f > 1000 && (p > 5 || h >= 30)) return "🟡 MEDIO";
  if (f > 300) return "🟡 MEDIO";
  return "🔴 BAJO";
}
