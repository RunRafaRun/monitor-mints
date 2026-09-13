// Cloudflare Pages Function — análisis "a fondo" de un mint con IA (bajo demanda,
// botón "Analizar a fondo" en el dashboard). A diferencia del veredicto gratis
// (reglas fijas, calculado en el navegador desde datos ya conocidos), aquí se le
// pasan los mismos datos + la imagen del proyecto a Claude para que dé un juicio
// cualitativo: ¿pinta a scam? ¿es el típico reparto para endosar la reserva del
// equipo al público? etc.
//
//   POST /api/analyze  { name, slug?, image?, chain, minted, supply, priceEth,
//                        free, floorEth, floorUsd, phases:[{k,label,state,priceEth}],
//                        team, xFollowers, xAgeDays, xRenames, xLastRename, hype,
//                        pop, haveKey }
//   -> { text, model }
//
// Requiere ANTHROPIC_API_KEY como env var del proyecto de Pages. Sin ella,
// devuelve 503 not_configured (el botón lo indica en el dashboard).
//
// Coste: una llamada a Claude Opus 5 por click, con max_tokens bajo y esfuerzo
// "low" para mantenerlo barato y rápido. NO hay límite de peticiones aquí —
// si el botón queda público, protégelo con una regla de Rate Limiting de
// Cloudflare sobre /api/analyze (esta función por sí sola no frena abuso).

const ANTHROPIC_MODEL = "claude-opus-5";

export async function onRequestPost({ request, env }) {
  const key = env.ANTHROPIC_API_KEY;
  if (!key) return j({ error: "not_configured" }, 503);

  const body = await request.json().catch(() => null);
  if (!body || !body.name) return j({ error: "bad_request" }, 400);

  const image = await resolveImage(body, env).catch(() => null);
  const prompt = buildPrompt(body);

  const content = [];
  if (image) content.push({ type: "image", source: { type: "url", url: image } });
  content.push({ type: "text", text: prompt });

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 700,
        output_config: { effort: "low" },
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content }],
      }),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      return j({ error: "anthropic_failed", detail: detail.slice(0, 300) }, 502);
    }
    const data = await r.json();
    const text = (data.content || []).find((b) => b.type === "text")?.text || "";
    if (!text) return j({ error: "empty_response" }, 502);
    return j({ text, model: data.model, hadImage: !!image });
  } catch (e) {
    return j({ error: "server_error", detail: String((e && e.message) || e).slice(0, 200) }, 500);
  }
}

const SYSTEM_PROMPT = `Eres un analista escéptico de mints NFT. Te dan datos de un proyecto (y a veces su
imagen/logo) y debes juzgar, en base a patrones típicos de scam, si merece la pena mintear.

Fíjate especialmente en:
- Imagen: arte genérico/plantilla, placeholder, o robado/muy similar a otro proyecto conocido.
- Nombre: copia o variación obvia de una colección ya establecida (copycat).
- Economía: precio público vs floor actual (si el floor ya está por debajo del precio público, mintear
  ahora mismo da pérdida). Supply muy grande sin demanda real.
- Estructura de fases: si las fases WL/GTD/FCFS (baratas o gratis) ya se repartieron y "el público" solo
  puede entrar en la fase pública cara — patrón clásico de "el equipo/insiders se quedan lo bueno barato
  y le pasan al público la reserva/lo que sobra".
- Señales de la cuenta de X: cuenta muy nueva, pocos seguidores, o que ha cambiado de nombre varias veces
  (cuenta reciclada — comprada ya con seguidores y renombrada para simular legitimidad).
- Equipo anónimo sin trayectoria verificable.

Responde SIEMPRE en este formato exacto, en español, sin nada antes ni después:

VEREDICTO: <VALE_LA_PENA|DUDOSO|EVITAR>
RESUMEN: <una frase>
RAZONES:
- <razón 1>
- <razón 2>
- <razón 3 opcional>

No es asesoramiento financiero. Sé directo y conciso — nada de relleno.`;

function buildPrompt(b) {
  const phases = (b.phases || [])
    .map((p) => `${p.k}${p.label ? " (" + p.label + ")" : ""}: ${p.priceEth != null ? p.priceEth + " ETH" : p.p || "?"} — ${p.state || p.s || "?"}`)
    .join("\n  ");
  const mult = b.floorUsd != null && b.priceEth != null && b.priceEth > 0 ? (b.floorUsd / (b.priceEth * (b.ethUsd || 1))).toFixed(2) : null;
  return `Proyecto: ${b.name} (cadena: ${b.chain || "?"})
Supply: ${b.minted ?? "?"} / ${b.supply ?? "?"} minteados
Precio público: ${b.free ? "GRATIS (solo gas)" : (b.priceEth != null ? b.priceEth + " ETH" : "desconocido")}
Floor actual: ${b.floorEth != null ? b.floorEth + " ETH ($" + (b.floorUsd ?? "?") + ")" : "sin mercado / desconocido"}${mult ? ` (floor/precio ≈ ${mult}×)` : ""}
Fases:
  ${phases || "(sin datos de fases)"}
¿Ya tienes acceso a alguna fase de llave (WL/GTD/FCFS)?: ${b.haveKey ? "sí" : "no"}
Hype interno: ${b.hype ?? "?"}/100 · Popularidad: ${b.pop || "?"}
Equipo: ${b.team || "desconocido"}
Cuenta de X: ${b.xFollowers ?? "?"} seguidores, ${b.xAgeDays != null && b.xAgeDays >= 0 ? b.xAgeDays + " días de antigüedad" : "antigüedad desconocida"}${b.xRenames ? `, ⚠️ cambió de nombre ${b.xRenames} vez/veces (última: ${b.xLastRename || "?"})` : ", sin cambios de nombre detectados"}`;
}

// Imagen del proyecto: preferimos la de la colección en OpenSea (más fiable/nítida);
// si no hay slug o falla, caemos al avatar de X que ya tenemos guardado (xAvatar).
async function resolveImage(b, env) {
  if (b.slug && env.OPENSEA_API_KEY) {
    try {
      const r = await fetch(`https://api.opensea.io/api/v2/collections/${encodeURIComponent(b.slug)}`, {
        headers: { "x-api-key": env.OPENSEA_API_KEY, accept: "application/json" },
      });
      if (r.ok) {
        const c = await r.json();
        if (c.image_url) return c.image_url;
      }
    } catch {}
  }
  return b.image || null;
}

function j(o, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json; charset=utf-8" } });
}
