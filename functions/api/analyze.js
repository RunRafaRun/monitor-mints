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
// oficial de X para eso es de pago); sí usamos la bio de X (vxtwitter, gratis).
//
// Si además hay un binding KV llamado "PREDICTIONS" (Workers & Pages → KV →
// Create namespace, luego Bindings → Add → KV → variable name "PREDICTIONS"),
// cada veredicto se guarda para revisarlo después del mint — ver
// review-predictions.js. Sin ese binding, el análisis funciona igual, solo que
// no queda constancia para aprender de aciertos/fallos.
//
// NO hay límite de peticiones aquí — si el botón queda público, protégelo con una
// regla de Rate Limiting de Cloudflare sobre /api/analyze (esta función por sí
// sola no frena abuso, y aunque sea gratis hasta las 10.000 neuronas/día, a partir
// de ahí se cobra).

const VISION_MODEL = "@cf/llava-hf/llava-1.5-7b-hf";
const TEXT_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

export async function onRequestPost({ request, env, waitUntil }) {
  if (!env.AI) return j({ error: "not_configured" }, 503);

  const body = await request.json().catch(() => null);
  if (!body || !body.name) return j({ error: "bad_request" }, 400);

  const [imageUrl, bio, site, sales] = await Promise.all([
    resolveImage(body, env).catch(() => null),
    body.x ? fetchXBio(body.x).catch(() => null) : null,
    body.site ? fetchSiteInfo(body.site).catch(() => null) : null,
    body.slug ? fetchSalesEvents(body.slug, env).catch(() => null) : null,
  ]);
  const extra = { bio, site, sales };

  // Se genera SIEMPRE en español (es donde el modelo es fiable con el formato) y,
  // si la web está en inglés, se traduce con una segunda llamada rápida al modelo
  // de texto — más robusto que pedirle a LLaVA que razone y traduzca a la vez
  // (con imagen de por medio ignoraba la instrucción de idioma).
  try {
    let raw, model;
    const imageBytes = imageUrl && (await fetchImageBytes(imageUrl).catch(() => null));
    if (imageBytes) {
      model = VISION_MODEL;
      const prompt = SYSTEM_PROMPT + "\n\n" + buildPrompt(body, extra);
      raw = await env.AI.run(VISION_MODEL, { image: imageBytes, prompt, max_tokens: 600 });
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
    let text = typeof raw === "string" ? raw : (raw.response || raw.description || raw.result || "");
    if (!text) return j({ error: "empty_response" }, 502);
    if (env.PREDICTIONS) {
      const savePromise = savePrediction(env, body, text).catch(() => {});
      if (waitUntil) waitUntil(savePromise); else await savePromise;
    }
    if (body.lang === "en") text = await translateToEnglish(env, text).catch(() => text);
    return j({ text, model, hadImage: !!imageBytes, hadSite: !!site, hadBio: !!bio, hadSales: !!sales });
  } catch (e) {
    return j({ error: "server_error", detail: String((e && e.message) || e).slice(0, 300) }, 500);
  }
}

const SYSTEM_PROMPT = `Eres un analista escéptico de mints NFT. Con los datos de un proyecto (a veces
imagen, bio de X, extracto de su web) juzga si merece la pena mintear, buscando señales de scam.

Fíjate en:
- Imagen (si la hay): describe brevemente qué se ve (tipo de sujeto: animal, robot, humano, abstracto...)
  y si el arte parece genérico, plantilla o copiado del estilo de otra colección conocida.
- Nombre: si aparece algo en "Proyectos parecidos ya vistos", es posible copia de otra colección de la
  misma red — coméntalo.
- Qué es el proyecto: según la bio de X y el extracto de la web, a qué dice dedicarse, y si tiene
  whitepaper/docs enlazados (su ausencia en un proyecto que promete "utilidad" es mala señal).
- Precio vs floor: si el floor ya está por debajo del precio público, mintear ahora da pérdida.
- Floor fiable o no: pocas ventas totales, o ventas con el mismo comprador y vendedor, es floor poco
  fiable o wash trading. Pocos propietarios únicos frente a lo minteado sugiere acumulación, no comunidad.
- Estructura de fases: si las fases baratas/gratis (WL/GTD/FCFS) ya se repartieron y solo queda la fase
  pública cara, es la señal clásica de "el equipo se queda lo barato y le pasa al público lo que sobra".
- Cuenta de X: muy nueva, pocos seguidores, o que ha cambiado de nombre varias veces (cuenta reciclada).
- Equipo anónimo sin trayectoria verificable.

No cites cifras exactas de supply, número de fases o precios — el usuario ya las ve aparte en una ficha.
Haz solo la valoración cualitativa (ej. "la oferta parece grande para el interés que muestra", no "hay
4444 unidades en 3 fases").

Responde SIEMPRE en este formato, sin nada antes ni después:

VEREDICTO: <VALE_LA_PENA|DUDOSO|EVITAR>
RESUMEN: <una frase>
RAZONES:
- <razón 1>
- <razón 2>
- <razón 3 opcional>
- <razón 4 opcional>

Las etiquetas VEREDICTO/RESUMEN/RAZONES y el valor de VEREDICTO (VALE_LA_PENA, DUDOSO o EVITAR) van
siempre literalmente así, sin traducir, sin importar en qué idioma escribas el resto. Cada razón empieza
por un guion "-", sin asteriscos. No es asesoramiento financiero. Sé breve y directo.`;

// El resto del prompt (arriba) queda fijo en español para que el modelo razone siempre igual;
// esto solo le pide traducir el CONTENIDO (resumen + razones) al idioma de la web, manteniendo
// las etiquetas de formato intactas para que el parser del cliente siga funcionando.
// Traduce el resultado (ya generado en español) al inglés con una llamada aparte
// y rápida al modelo de texto — separar "razonar" de "traducir" es más fiable que
// pedirle las dos cosas a la vez a un modelo pequeño, sobre todo al de visión.
async function translateToEnglish(env, text) {
  const raw = await env.AI.run(TEXT_MODEL, {
    messages: [
      {
        role: "system",
        content: "Translate the following NFT mint analysis into natural English. Keep the literal labels "
          + "'VEREDICTO:', 'RESUMEN:' and 'RAZONES:' untranslated, and keep the value after VEREDICTO "
          + "(VALE_LA_PENA, DUDOSO or EVITAR) untranslated exactly as given. Translate only the free text after "
          + "RESUMEN: and each '-' bullet under RAZONES. Output ONLY the translated text in the same structure, "
          + "nothing else before or after.",
      },
      { role: "user", content: text },
    ],
    max_tokens: 700,
  });
  const translated = typeof raw === "string" ? raw : (raw.response || raw.description || raw.result || "");
  return translated || text;
}

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
${salesLine(extra.sales)}
Bio de X: ${extra.bio || "(no disponible)"}
Proyectos parecidos ya vistos en el radar (misma red, nombre similar): ${similar.length ? similar.join(", ") : "ninguno detectado"}
Web del proyecto: ${b.site ? (extra.site ? `\n  Whitepaper/docs enlazados: ${extra.site.whitepaper || "no encontrados en la portada"}\n  Extracto de la web: "${extra.site.text || "(sin texto legible)"}"` : "(no se pudo leer la web)") : "(sin web enlazada)"}`;
}

function salesLine(sales) {
  if (!sales) return "Últimas ventas reales: (no disponible — sin slug de OpenSea o petición fallida)";
  if (!sales.sales) return "Últimas ventas reales: ninguna venta registrada — el floor (si lo hay) es solo un listado, sin demanda confirmada";
  const parts = [`${sales.sales} venta(s) recientes analizadas`, `${sales.uniqueBuyers} comprador(es) distinto(s)`, `${sales.uniqueSellers} vendedor(es) distinto(s)`];
  if (sales.lastSalePrice != null) parts.push(`última venta real: ${sales.lastSalePrice} ${sales.lastSaleSymbol || ""}`.trim());
  if (sales.selfTrades > 0) parts.push(`⚠️ ${sales.selfTrades} venta(s) con el MISMO comprador y vendedor (autoventa)`);
  if (sales.walletOverlap > 0) parts.push(`⚠️ ${sales.walletOverlap} wallet(s) que aparecen como comprador Y vendedor entre las ventas vistas`);
  if (sales.suspicious) parts.push("→ patrón sospechoso de wash trading");
  return "Últimas ventas reales (OpenSea events): " + parts.join(", ");
}

// Eventos de venta reales de OpenSea (no solo el floor listado) para distinguir un
// floor de verdad de una oferta suelta, y detectar wash trading básico (misma
// wallet comprando/vendiendo, pocas wallets distintas moviendo todas las ventas).
async function fetchSalesEvents(slug, env) {
  if (!env.OPENSEA_API_KEY) return null;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(`https://api.opensea.io/api/v2/events/collection/${encodeURIComponent(slug)}?event_type=sale&limit=20`, {
      signal: ctrl.signal,
      headers: { "x-api-key": env.OPENSEA_API_KEY, accept: "application/json" },
    });
    if (!r.ok) return { sales: 0 };
    const j2 = await r.json();
    const events = j2?.asset_events || [];
    if (!events.length) return { sales: 0 };
    const buyers = new Set(), sellers = new Set();
    let selfTrades = 0;
    for (const e of events) {
      const buyer = (e.buyer || "").toLowerCase(), seller = (e.seller || "").toLowerCase();
      if (buyer) buyers.add(buyer);
      if (seller) sellers.add(seller);
      if (buyer && seller && buyer === seller) selfTrades++;
    }
    const walletOverlap = [...buyers].filter((a) => sellers.has(a)).length;
    const last = events[0];
    const p = last?.payment;
    const lastSalePrice = p ? Number(p.quantity) / 10 ** (p.decimals ?? 18) : null;
    const suspicious = selfTrades > 0 || walletOverlap >= 2 || (events.length >= 4 && (buyers.size <= 2 || sellers.size <= 2));
    return {
      sales: events.length, uniqueBuyers: buyers.size, uniqueSellers: sellers.size,
      selfTrades, walletOverlap, lastSalePrice, lastSaleSymbol: p?.symbol || null,
      lastSaleAt: last?.closing_date || last?.event_timestamp || null, suspicious,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(to);
  }
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

// Guarda el veredicto en KV para poder revisarlo más adelante (ver
// review-predictions.js). Una entrada por proyecto+red: cada análisis nuevo
// sobreescribe el anterior (nos interesa el último pronóstico antes del mint,
// no un historial de reintentos). Requiere el binding KV "PREDICTIONS"
// (Cloudflare dashboard → proyecto → Settings → Bindings → Add → KV namespace
// → variable name "PREDICTIONS"; hay que crear el namespace una vez en
// Workers & Pages → KV → Create namespace).
async function savePrediction(env, b, text) {
  const vm = /VEREDICTO:\s*(VALE_LA_PENA|DUDOSO|EVITAR)/i.exec(text);
  if (!vm) return;
  const key = predKey(b.chain, b.slug || b.name);
  const record = {
    name: b.name, chain: b.chain || null, slug: b.slug || null,
    verdict: vm[1].toUpperCase(), reasoning: text.slice(0, 1500), predictedAt: new Date().toISOString(),
    priceEth: b.priceEth ?? null, priceUsd: b.priceUsd ?? null, floorEth: b.floorEth ?? null, floorUsd: b.floorUsd ?? null,
    when: b.when ?? null, sales: b.sales ?? null, ownersPct: b.ownersPct ?? null, team: b.team ?? null,
    xRenames: b.xRenames ?? null, xAgeDays: b.xAgeDays ?? null,
    reviewedAt: null, outcome: null,
  };
  await env.PREDICTIONS.put(key, JSON.stringify(record));
}

function predKey(chain, slugOrName) {
  const norm = String(slugOrName || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `pred:${chain || "robinhood"}:${norm}`;
}

function j(o, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json; charset=utf-8" } });
}
