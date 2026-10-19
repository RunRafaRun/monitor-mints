import { parseFeed, popularityVerdict } from "../scripts/lib/trencher.mjs";

const FEED_URL = "https://cdn.neverfuckingtrade.com/feed.html";
const KEYPHASE = ["GTD", "FCFS", "WL", "HOLDER"];

export default async () => {
  const now = Date.now();
  const soonCut = now + 72 * 3600e3;
  const relevant = (g) => KEYPHASE.includes(g.kind) && (g.endMs ?? 0) > now;

  // Una sola descarga del feed (~1MB) para todas las cadenas
  const r = await fetch(`${FEED_URL}?v=${now}`, {
    headers: { "user-agent": "Mozilla/5.0 (Monitor-MINTS)" },
  });
  if (!r.ok) return Response.json({ mints: [], updated: new Date().toISOString(), error: `feed ${r.status}` });
  const html = await r.text();
  const allCards = parseFeed(html, null); // null = todas las cadenas

  const seen = new Map();
  for (const c of allCards) {
    const k = (c.chain || "robinhood") + "|" + c.name.toLowerCase();
    const score = (x) => (x.hype ?? 0) + (x.x ? 5 : 0) + x.gates.length;
    if (!seen.has(k) || score(c) > score(seen.get(k))) seen.set(k, c);
  }

  const mints = [...seen.values()].map((c) => {
    const liveGate = c.gates.find((g) => g.state === "live" || ((g.startMs ?? 0) <= now && (g.endMs ?? 1e18) > now));
    const openKey = c.gates.find((g) => relevant(g) && (g.startMs ?? 0) <= now && (g.endMs ?? 0) > now);
    const nextGate = c.gates.filter((g) => relevant(g) && (g.startMs ?? 0) > now).sort((a, b) => a.startMs - b.startMs)[0];
    let status = "later";
    if (c.isLive || liveGate) status = "now";
    else if (nextGate && nextGate.startMs <= soonCut) status = "soon";
    else if (c.startMs && c.startMs > now && c.startMs <= soonCut) status = "soon";
    const openGate = openKey || liveGate;
    return {
      name: c.name, status, chain: c.chain || "robinhood",
      minted: c.minted, supply: c.supply, mintRate: c.mintRate,
      hype: c.hype ?? 0, tier: c.tier, team: c.team,
      xFollowers: c.xFollowers, xPosts: c.xPosts, xAgeDays: c.xAgeDays, socials: c.socials,
      xRenames: null, xLastRename: null, xAvatar: null,
      pop: popularityVerdict(c),
      priceEth: c.priceEth ?? null, free: !!c.free,
      when: (openGate || nextGate)?.startMs ?? c.startMs ?? null,
      phases: c.gates.filter((g) => g.kind !== "OTHER").map((g) => ({
        k: g.kind, n: (g.label || g.name || "").trim() || null,
        p: g.price || g.priceText || "?", s: g.state,
        a: g.startMs, e: g.endMs, lim: g.perWallet,
      })),
      need: [], haveKey: false,
      x: c.x, site: c.site, opensea: c.opensea, slug: c.openseaSlug || null,
      contract: (c.contract || "").toLowerCase() || null,
      srcs: 1,
    };
  }).filter((m) => m.status !== "later");

  mints.sort((a, b) => a.status === b.status ? b.hype - a.hype : a.status === "now" ? -1 : 1);

  return Response.json({ mints, updated: new Date().toISOString() }, {
    headers: { "Cache-Control": "public, max-age=240" },
  });
};
