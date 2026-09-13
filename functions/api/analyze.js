// Cloudflare Pages Function — análisis "a fondo" de un mint con IA (bajo demanda,
// botón "Analizar a fondo" en el dashboard). A diferencia del veredicto gratis
// (reglas fijas, calculado en el navegador desde datos ya conocidos), aquí se le
// pasan los mismos datos + imagen + bio de X + contenido de la web del proyecto
// a un modelo para que dé un juicio cualitativo: ¿pinta a scam? ¿arte derivativo?
// ¿nombre calcado a otro proyecto? ¿a qué se dedica según su propia web?
//
//   POST /api/analyze  { name, slug?, image?, x?, site?, chain, minted, supply,
//                        priceEth, free, floorEth, floorUsd,
//                        phases:[{k,label,state,priceEth}], team, xFollowers,
//                        xAgeDays, xRenames, xLastRename, hype, pop, haveKey,
//                        similarNames?:[...] }
//   -> { text, model, hadImage }
//
// Usa Cloudflare Workers AI (modelos open-source, gratis: 10.000 "neuronas"/día
// sin tarjeta) en vez de una API de pago — no hace falta ninguna clave, solo
// activar el binding "AI" en el proyecto de Pages:
//   Cloudflare dashboard → tu proyecto → Settings → (entorno Production) → Bindings
//   → Add → Workers AI → variable name "AI".
// Importante: el binding solo se aplica a los deployments creados DESPUÉS de
// guardarlo — un simple "Retry deployment" de uno viejo no lo recoge, hace
// falta un deployment nuevo (push, o "Create deployment" en el dashboard).
// Sin ese binding, devuelve 503 not_configured (el botón lo indica en el dashboard).
//
// Con imagen -> @cf/llava-hf/llava-1.5-7b-hf (visión). Sin imagen -> @cf/meta/llama-3.1-8b-instruct-fast
// (texto). Ambos son modelos abiertos servidos por Cloudflare, no hay llamada a terceros.
//
// Nota: no hay forma gratuita de leer el "tweet fijado" de una cuenta (la API
// oficial de X para eso es de pago); sí usamos la bio de X (fxtwitter, gratis).
//
// NO hay límite de peticiones aquí — si el botón queda público, protégelo con una
// regla de Rate Limiting de Cloudflare sobre /api/analyze (esta función por sí
// sola no frena abuso, y aunque sea gratis hasta las 10.000 neuronas/día, a partir
// de ahí se cobra).

const VISION_MODEL = "@cf/llava-hf/llava-1.5-7b-hf";
const TEXT_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

export async function onRequestPost({ request, env }) {
  if (!env.AI) return j({ error: "not_configured" }, 503);

  const body = await request.json().catch(() => null);
  if (!body || !body.name) return j({ error: "bad_request" }, 400);

  const [imageUrl, bio, site] = await Promise.all([
    resolveImage(body, env).catch(() => null),
    body.x ? fetchXBio(body.x).catch(() => null) : null,
    body.site ? fetchSiteInfo(body.site).catch(() => null) : null,
  ]);
  const extra = { bio, site };

  try {
    let raw, model;
    const imageBytes = imageUrl && (await fetchImageBytes(imageUrl).catch(() => null));
    if (imageBytes) {
      model = VISION_MODEL;
      const prompt = SYSTEM_PROMPT + "\n\n" + buildPrompt(body, extra);
      raw = await env.AI.run(VISION_MODEL, { image: imageBytes, prompt, max_tokens: 800 });
    } else {
      model = TEXT_MODEL;
      raw = await env.AI.run(TEXT_MODEL, {
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildPrompt(body, extra) },
        ],
        max_tokens: 600,
      });
    }
    const text = typeof raw === "string" ? raw : (raw.response || raw.description || raw.result || "");
    if (!text) return j({ error: "empty_response" }, 502);
    return j({ text, model, hadImage: !!imageBytes, hadSite: !!site, hadBio: !!bio });
  } catch (e) {
    return j({ error: "server_error", detail: String((e && e.message) || e).slice(0, 300) }, 500);
  }
}

const SYSTEM_PROMPT = `Eres un analista escéptico de mints NFT. Te dan datos de un proyecto (a veces su
imagen/logo, bio de X, y un extracto de su propia web) y debes juzgar, en base a patrones típicos de
scam, si merece la pena mintear.

Fíjate especialmente en:
- Imagen (si la hay): describe brevemente el arte y valora si parece genérico/plantilla, un placeholder,
  o muy similar al estilo de otra colección conocida (posible arte derivativo/robado).
- Nombre: si en "Proyectos parecidos ya vistos" aparece algo, coméntalo como posible copia/variación de
  una colección ya establecida en la misma red (copycat).
- Qué es el proyecto: usa la bio de X y el extracto de la web para explicar en una frase a qué dice
  dedicarse (arte, gaming, utilidad real, "comunidad" sin más, etc.) y si tiene whitepaper/docs enlazados
  — su ausencia total en un proyecto que promete "utilidad" es una señal de alerta.
- Economía: precio público vs floor actual (si el floor ya está por debajo del precio público, mintear
  ahora mismo da pérdida). Supply muy grande sin demanda real.
- Fiabilidad del floor (dato de OpenSea, no on-chain directo): si hay muy pocas ventas totales (<3) el
  floor no es de fiar, puede ser una sola oferta/venta entre wallets del propio equipo (wash trading) más
  que demanda real — dilo explícitamente si "ventas totales" es bajo o "mercado mínimo" está marcado.
  Si el % de propietarios únicos sobre lo minteado es muy bajo (mucha concentración en pocas wallets),
  es otra señal de posible acumulación/wash trading, no de comunidad real.
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
- <razón 4 opcional>

Usa EXACTAMENTE ese formato: cada razón empieza por un guion "-", sin asteriscos ni otro
formato markdown, sin texto antes de VEREDICTO ni después de la última razón.
No es asesoramiento financiero. Sé directo y conciso — nada de relleno, máximo 4 razones cortas.`;

function buildPrompt(b, extra) {
  const phases = (b.phases || [])
    .map((p) => `${p.k}${p.label ? " (" + p.label + ")" : ""}: ${p.priceEth != null ? p.priceEth + " ETH" : p.p || "?"} — ${p.state || p.s || "?"}`)
    .join("\n  ");
  const mult = b.floorUsd != null && b.priceEth != null && b.priceEth > 0 ? (b.floorUsd / (b.priceEth * (b.ethUsd || 1))).toFixed(2) : null;
  const similar = (b.similarNames || []).filter((n) => n && n !== b.name);
  return `Proyecto: ${b.name} (cadena: ${b.chain || "?"})
Supply: ${b.minted ?? "?"} / ${b.supply ?? "?"} minteados
Precio público: ${b.priceEth === 0 ? "GRATIS (solo gas)" : b.priceEth != null ? b.priceEth + " ETH" : b.free ? "desconocido (aunque hay alguna fase WL/GTD gratis, la pública no tiene precio confirmado)" : "desconocido"}
Floor actual: ${b.floorEth != null ? b.floorEth + " ETH ($" + (b.floorUsd ?? "?") + ")" : "sin mercado / desconocido"}${mult ? ` (floor/precio ≈ ${mult}×)` : ""}${b.floorThin ? " — ⚠️ MERCADO MÍNIMO, floor poco fiable" : ""}
Ventas totales registradas en OpenSea: ${b.sales ?? "?"}${b.sales != null && b.sales < 3 ? " (muy pocas — el floor puede no reflejar demanda real)" : ""}
Propietarios únicos: ${b.owners ?? "?"}${b.ownersPct != null ? ` (${Math.round(b.ownersPct * 100)}% de lo minteado — ` + (b.ownersPct < 0.4 ? "concentración alta, posible acumulación" : "reparto normal") + ")" : ""}
Fases:
  ${phases || "(sin datos de fases)"}
¿Ya tienes acceso a alguna fase de llave (WL/GTD/FCFS)?: ${b.haveKey ? "sí" : "no"}
Hype interno: ${b.hype ?? "?"}/100 · Popularidad: ${b.pop || "?"}
Equipo: ${b.team || "desconocido"}
Cuenta de X: ${b.xFollowers ?? "?"} seguidores, ${b.xAgeDays != null && b.xAgeDays >= 0 ? b.xAgeDays + " días de antigüedad" : "antigüedad desconocida"}${b.xRenames ? `, ⚠️ cambió de nombre ${b.xRenames} vez/veces (última: ${b.xLastRename || "?"})` : ", sin cambios de nombre detectados"}
Bio de X: ${extra.bio || "(no disponible)"}
Proyectos parecidos ya vistos en el radar (misma red, nombre similar): ${similar.length ? similar.join(", ") : "ninguno detectado"}
Web del proyecto: ${b.site ? (extra.site ? `\n  Whitepaper/docs enlazados: ${extra.site.whitepaper || "no encontrados en la portada"}\n  Extracto de la web: "${extra.site.text || "(sin texto legible)"}"` : "(no se pudo leer la web)") : "(sin web enlazada)"}`;
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

// LLaVA (Workers AI) quiere la imagen como array de bytes, no una URL.
async function fetchImageBytes(url) {
  const r = await fetch(url);
  if (!r.ok) return null;
  const buf = await r.arrayBuffer();
  if (buf.byteLength > 8 * 1024 * 1024) return null; // evita imágenes enormes
  return [...new Uint8Array(buf)];
}

function xHandle(url) {
  const m = /(?:x|twitter)\.com\/(?:#!\/)?@?([A-Za-z0-9_]{1,15})/i.exec(url || "");
  return m ? m[1] : null;
}

// Bio de la cuenta de X vía vxtwitter (gratis, sin clave; fxtwitter bloquea con 401
// las IPs de Cloudflare, vxtwitter no). No hay forma gratuita de leer el tweet
// fijado — esa parte de la API de X es de pago.
async function fetchXBio(xUrl) {
  const handle = xHandle(xUrl);
  if (!handle) return null;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(`https://api.vxtwitter.com/${encodeURIComponent(handle)}`, {
      signal: ctrl.signal,
      headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36" },
    });
    if (!r.ok) return null;
    const j2 = await r.json();
    return (j2?.description || j2?.user?.description || "").slice(0, 300) || null;
  } catch {
    return null;
  } finally {
    clearTimeout(to);
  }
}

// Extracto de texto de la web del proyecto + detección de enlace a whitepaper/docs.
async function fetchSiteInfo(url) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { "user-agent": "Mozilla/5.0 (compatible; MintscopeBot/1.0)" } });
    if (!r.ok) return null;
    const html = (await r.text()).slice(0, 200000); // no proceses páginas gigantes
    const wpMatch = /<a[^>]+href="([^"]+)"[^>]*>[^<]{0,40}(white\s*paper|litepaper|docs)/i.exec(html);
    const pdfMatch = !wpMatch && /href="([^"]*\.pdf[^"]*)"/i.exec(html);
    const whitepaper = wpMatch?.[1] || pdfMatch?.[1] || null;
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;|&amp;|&quot;|&#39;/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 1200);
    return { text, whitepaper };
  } catch {
    return null;
  } finally {
    clearTimeout(to);
  }
}

function j(o, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json; charset=utf-8" } });
}
