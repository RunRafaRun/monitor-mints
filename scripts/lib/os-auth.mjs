// Sesión de OpenSea para consultar la elegibilidad (WL/GTD/FCFS) de tu wallet.
//
// Usa el CLI oficial: `opensea` si está en PATH, si no `npx -y @opensea/cli@2`
// (se descarga solo la 1ª vez). El login es OAuth por navegador, SIN clave
// privada: firmas un mensaje en opensea.io. El token queda en
// ~/.opensea/auth.json (o $OPENSEA_CONFIG_DIR/auth.json), en tu máquina.

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const WIN = process.platform === "win32";
const ADDR_RE = /0x[0-9a-fA-F]{40}/;
const JWT_RE = /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/;

let _base;
export function osCliBase() {
  if (_base !== undefined) return _base;
  for (const cand of [["opensea"], ["npx", "-y", "@opensea/cli@2"]]) {
    try {
      execFileSync(cand[0], [...cand.slice(1), "--version"], { stdio: "ignore", shell: WIN });
      return (_base = cand);
    } catch { /* siguiente candidato */ }
  }
  return (_base = null);
}

export function osCli(args, { allowFail = true, inheritErr = false } = {}) {
  const b = osCliBase();
  if (!b) { if (allowFail) return null; throw new Error("Falta el CLI de OpenSea (npm i -g @opensea/cli)"); }
  try {
    return execFileSync(b[0], [...b.slice(1), ...args], {
      encoding: "utf8", stdio: ["ignore", "pipe", inheritErr ? "inherit" : "ignore"], shell: WIN,
    });
  } catch (e) { if (allowFail) return null; throw e; }
}

export function authFile() {
  return join(process.env.OPENSEA_CONFIG_DIR || join(homedir(), ".opensea"), "auth.json");
}

// Lee el token del auth.json (bearer JWT + caducidad + dirección) de forma robusta
// aunque cambie la forma exacta del fichero.
export function readAuth() {
  const f = authFile();
  if (!existsSync(f)) return null;
  let j; try { j = JSON.parse(readFileSync(f, "utf8")); } catch { return null; }
  let jwt = null, exp = null, addr = null;
  const walk = (o) => {
    if (o == null) return;
    if (typeof o === "string") {
      if (!jwt && JWT_RE.test(o)) jwt = o;
      else if (!addr && ADDR_RE.test(o) && o.length === 42) addr = o.toLowerCase();
      return;
    }
    if (typeof o !== "object") return;
    for (const [k, v] of Object.entries(o)) {
      if (!exp && /^(expires_?at|exp)$/i.test(k)) {
        if (typeof v === "number" || /^\d+$/.test(String(v))) { const n = Number(v); exp = n > 1e12 ? n : n * 1000; }
        else if (typeof v === "string") { const d = Date.parse(v); if (d) exp = d; } // ISO
      }
      walk(v);
    }
  };
  walk(j);
  const claims = jwtClaims(jwt);
  if (!exp && claims?.exp) exp = claims.exp * 1000;
  if (!addr && claims) addr = String(claims.address || claims.sub || claims.wallet || "").match(ADDR_RE)?.[0]?.toLowerCase() || null;
  return { jwt, exp, address: addr };
}

// El token de sesión de OpenSea dura poco (~1 h). Antes de usarlo, si ya caducó
// o le queda poco, pedimos al CLI que lo renueve con el refresh token (sin
// navegador, sin firma). Devuelve el auth ya fresco (o el que había si falla).
export function refreshAuth({ marginMs = 5 * 60 * 1000 } = {}) {
  const a = readAuth();
  if (a?.exp && a.exp - Date.now() > marginMs) return a;      // aún vale
  if (!osCliBase()) return a;                                  // sin CLI no hay nada que hacer
  const out = osCli(["auth", "refresh", "--format", "json"]) || osCli(["auth", "refresh"]);
  const fresh = readAuth();
  if (out && fresh?.exp && fresh.exp > Date.now()) return fresh;
  return fresh || a;
}

function jwtClaims(jwt) {
  if (!jwt) return null;
  try { return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString()); } catch { return null; }
}

// { address, scopes, exp } o null si no hay sesión.
// Primero el auth.json (rápido, sin lanzar procesos); el CLI solo como respaldo.
export function whoami({ cliFallback = true } = {}) {
  const a = readAuth();
  if (a && a.address && (!a.exp || a.exp > Date.now())) return { address: a.address, scopes: null, exp: a.exp };
  if (!cliFallback) return a && a.address ? { address: a.address, scopes: null, exp: a.exp } : null;
  const out = osCli(["whoami", "--format", "json"]) || osCli(["whoami"]);
  if (out) {
    try {
      const j = JSON.parse(out);
      const address = String(j.address || j.wallet || j.account || "").match(ADDR_RE)?.[0]?.toLowerCase();
      if (address) return { address, scopes: j.scopes || j.scope || null, exp: j.expiresAt || j.exp || null };
    } catch {
      const m = out.match(ADDR_RE);
      if (m) return { address: m[0].toLowerCase(), scopes: null, exp: null };
    }
  }
  return a && a.address ? { address: a.address, scopes: null, exp: a.exp } : null;
}

export function walletLabel(ROOT, address) {
  try {
    const p = join(ROOT, "data", "wallets.json");
    if (!existsSync(p)) return null;
    const j = JSON.parse(readFileSync(p, "utf8"));
    const list = Array.isArray(j) ? j : j.wallets || [];
    return list.find((w) => String(w.address || "").toLowerCase() === address)?.label || null;
  } catch { return null; }
}
