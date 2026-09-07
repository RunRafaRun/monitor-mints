// Cloudflare Pages Function — elegibilidad REAL de una wallet en OpenSea.
//
//   POST /api/os?op=nonce                        -> { nonce }
//   POST /api/os?op=auth   { message, signature } -> { jwt, expiresIn, address }
//   POST /api/os?op=elig   { jwt, slugs:[...] }   -> { drops: { slug: { stages:[{k,label,eligible,wlCount}] } } }
//
// El navegador solo firma un mensaje SIWE (personal_sign, sin transacción, sin
// clave privada). Toda la conversación con OpenSea (verify -> scoped token ->
// exchange -> /eligibility) va por aquí porque usa cookies de sesión y la clave
// del servidor. El JWT que se devuelve tiene únicamente el scope read:eligibility
// y caduca en ~1 h.
//
// Requiere OPENSEA_API_KEY como env var del proyecto de Pages.

const OS = "https://api.opensea.io";
const MAX_SLUGS = 45;

const STAGE_KIND = (type, label) => {
  const t = String(type || "").toUpperCase();
  const u = String(label || "").toUpperCase();
  if (t === "PUBLIC_SALE" || /PUBLIC/.test(u)) return "PUBLIC";
  if (/FCFS/.test(u)) return "FCFS";
  if (/\bGTD\b|GUARANTEED/.test(u)) return "GTD";
  if (/TEAM|TREASURY|PARTNER|VAULT|RESERVE|PRE-?MINT/.test(u)) return "TEAM";
  if (/HOLDER/.test(u)) return "HOLDER";
  return "WL";
};
const uu = (s) => String(s || "").replace(/-/g, "").toLowerCase();

export async function onRequestPost({ request, env }) {
  const key = env.OPENSEA_API_KEY;
  if (!key) return j({ error: "not_configured" }, 503);
  const op = new URL(request.url).searchParams.get("op");
  const H = { accept: "application/json", "x-api-key": key };

  try {
    if (op === "nonce") {
      const r = await fetch(`${OS}/api/v2/auth/siwe/nonce`, { method: "POST", headers: { accept: "application/json" } });
      if (!r.ok) return j({ error: "nonce_failed" }, 502);
      return j({ nonce: (await r.json()).nonce });
    }

    if (op === "auth") {
      const { message, signature } = await request.json().catch(() => ({}));
      if (!message || !signature) return j({ error: "bad_request" }, 400);
      const parsed = parseSiwe(message);
      if (!parsed) return j({ error: "bad_message" }, 400);

      const vr = await fetch(`${OS}/api/v2/auth/siwe/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: parsed, signature, chainArch: "EVM" }),
      });
      if (!vr.ok) return j({ error: "verify_failed", detail: (await vr.text()).slice(0, 300) }, 401);
      const cookie = pickCookies(vr.headers);
      if (!cookie) return j({ error: "no_session" }, 401);

      const cr = await fetch(`${OS}/api/v2/auth/tokens`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ label: `mintscope-${Date.now()}`, scopes: ["read:eligibility"], expiresInDays: 1 }),
      });
      if (!cr.ok) return j({ error: "pat_failed", detail: (await cr.text()).slice(0, 300) }, 401);
      const pat = (await cr.json()).token;

      const xr = await fetch(`${OS}/api/v2/auth/tokens/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subjectToken: pat, subjectTokenType: "ACCESS_TOKEN" }),
      });
      if (!xr.ok) return j({ error: "exchange_failed", detail: (await xr.text()).slice(0, 300) }, 401);
      const x = await xr.json();
      return j({ jwt: x.accessToken, expiresIn: x.expiresIn || 3600, address: (parsed.address || "").toLowerCase() });
    }

    if (op === "elig") {
      const { jwt, slugs } = await request.json().catch(() => ({}));
      if (!jwt || !Array.isArray(slugs)) return j({ error: "bad_request" }, 400);
      const AH = { ...H, authorization: `Bearer ${jwt}` };
      const drops = {};
      let n = 0, authErr = 0;
      for (const slug of [...new Set(slugs)].slice(0, MAX_SLUGS)) {
        n++;
        const [meta, elig] = await Promise.all([
          fetch(`${OS}/api/v2/drops/${encodeURIComponent(slug)}`, { headers: H }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
          fetch(`${OS}/api/v2/drops/${encodeURIComponent(slug)}/eligibility`, { headers: AH }).then(async (r) => {
            if (r.status === 401 || r.status === 403) authErr++;
            return r.ok ? r.json() : null;
          }).catch(() => null),
        ]);
        if (!meta || !Array.isArray(meta.stages)) continue;
        const byU = new Map((elig?.stages || []).map((s) => [uu(s.stage_uuid), s]));
        const stages = meta.stages.map((s) => {
          const e = byU.get(uu(s.uuid));
          return {
            k: STAGE_KIND(s.stage_type, s.label),
            label: s.label || null,
            eligible: e ? !!e.is_eligible : null,
            wlCount: s.allowlist_wallet_count ?? null,
          };
        });
        drops[slug] = { stages };
        if (n % 5 === 0) await new Promise((r) => setTimeout(r, 200));
      }
      return j({ drops, authError: authErr > 0 });
    }

    return j({ error: "unknown_op" }, 400);
  } catch (e) {
    return j({ error: "server_error", detail: String((e && e.message) || e).slice(0, 200) }, 500);
  }
}

function j(o, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json; charset=utf-8" } });
}

function pickCookies(headers) {
  let raw = [];
  if (typeof headers.getSetCookie === "function") raw = headers.getSetCookie();
  else { const sc = headers.get("set-cookie"); if (sc) raw = sc.split(/,(?=[^;]+?=)/); }
  const want = {};
  for (const c of raw) {
    const pair = c.split(";")[0];
    const i = pair.indexOf("=");
    if (i < 0) continue;
    const name = pair.slice(0, i).trim();
    if (name === "access_token" || name === "refresh_token") want[name] = pair.slice(i + 1).trim();
  }
  if (!want.access_token || !want.refresh_token) return null;
  return `access_token=${want.access_token}; refresh_token=${want.refresh_token}`;
}

// Parseo mínimo de un mensaje EIP-4361/SIWE al JSON que espera /siwe/verify.
function parseSiwe(message) {
  const lines = String(message).split("\n");
  const m0 = /^(?<domain>[^ ]+) wants you to sign in with your (?:(?<accountType>Ethereum|Solana|Bitcoin) )?account:$/.exec(lines[0] || "");
  if (!m0 || !lines[1]) return null;
  const F = { uri: "URI: ", version: "Version: ", chainId: "Chain ID: ", nonce: "Nonce: ", issuedAt: "Issued At: ", expirationTime: "Expiration Time: ", notBefore: "Not Before: ", requestId: "Request ID: " };
  const fields = {};
  let firstFieldLine = lines.length;
  for (let i = 2; i < lines.length; i++) {
    for (const [k, p] of Object.entries(F)) {
      if (fields[k] == null && lines[i].startsWith(p)) { fields[k] = lines[i].slice(p.length); firstFieldLine = Math.min(firstFieldLine, i); }
    }
  }
  const statement = lines.slice(2, firstFieldLine).join("\n").replace(/^\n+|\n+$/g, "").trim();
  const out = {
    domain: m0.groups.domain,
    address: lines[1].trim(),
    statement,
    uri: fields.uri || "",
    version: fields.version || "1",
    chainId: fields.chainId || "1",
    nonce: fields.nonce || "",
    issuedAt: fields.issuedAt || "",
  };
  if (m0.groups.accountType) out.accountType = m0.groups.accountType;
  if (fields.expirationTime) out.expirationTime = fields.expirationTime;
  if (fields.notBefore) out.notBefore = fields.notBefore;
  if (fields.requestId) out.requestId = fields.requestId;
  return out;
}
