// Servidor local del dashboard: los checkboxes de "Tengo" se guardan en
// colecciones.json de verdad, y hay botón de Actualizar.
//
//   node serve.mjs            -> http://localhost:8787  (y lo abre en el navegador)
//   node serve.mjs --port 9000
//
// Ctrl+C para parar.
import { createServer } from "node:http";
import { execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildData, html } from "./gen-dashboard.mjs";
import { loadCollections, saveCollections, findCollection, ROOT } from "./lib/data.mjs";
import { osCliBase, whoami, walletLabel } from "./lib/os-auth.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const PORT = Number(argv[argv.indexOf("--port") + 1]) || 8787;
const noFloors = argv.includes("--no-floors");

let cache = null;
let building = false;
async function rebuild() {
  if (building) return;
  building = true;
  try { cache = await buildData(); }
  catch (e) { console.error("build:", e.message); }
  finally { building = false; }
}
rebuild(); // primera carga en segundo plano

const LOADING = `<!doctype html><meta charset=utf-8><meta http-equiv=refresh content=3>
<body style="font:15px system-ui;background:#0f1115;color:#e7e9ee;padding:40px">
🚨 Monitor MINTS — cargando datos (feed + floors)… <br><br>se recarga sola.</body>`;

const server = createServer(async (req, res) => {
  const path = req.url.split("?")[0];
  try {
    if (path === "/") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      return res.end(cache ? html(cache, { served: true }) : LOADING);
    }
    if (!cache && path.startsWith("/api/")) {
      res.statusCode = 503; return res.end('{"loading":true}');
    }
    if (path === "/api/data") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify(cache));
    }
    if (path === "/api/owned" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { name, owned } = JSON.parse(body || "{}");
      const db = loadCollections();
      const col = findCollection(db, name);
      if (col) { col.owned = !!owned; saveCollections(db); console.log(`  ${owned ? "✅" : "⬜"} ${col.name}`); }
      await rebuild();
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ ok: !!col }));
    }
    if (path === "/api/refresh") {
      await rebuild();
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ ok: true, updated: cache.updated }));
    }

    // ---- OpenSea: sesión para la elegibilidad real (WL/GTD/FCFS) de tu wallet ----
    if (path === "/api/opensea/status") {
      const cliAvailable = !!osCliBase();
      let out = { connected: false, cliAvailable, loggingIn: !!loginChild, eligRunning, eligDoneAt };
      if (cliAvailable) {
        const me = whoami();
        if (me) out = { ...out, connected: true, address: me.address, label: walletLabel(ROOT, me.address), expiresAt: me.exp || null };
      }
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify(out));
    }
    if (path === "/api/opensea/login" && req.method === "POST") {
      res.setHeader("content-type", "application/json");
      if (!osCliBase()) return res.end(JSON.stringify({ error: "no-cli" }));
      const url = await startOsLogin();
      return res.end(JSON.stringify(url ? { url } : { error: "no-url" }));
    }
    if (path === "/api/eligibility/refresh" && req.method === "POST") {
      res.setHeader("content-type", "application/json");
      if (eligRunning) return res.end(JSON.stringify({ running: true }));
      kickElig();
      return res.end(JSON.stringify({ started: true }));
    }

    res.statusCode = 404;
    res.end("not found");
  } catch (e) {
    res.statusCode = 500;
    res.end(String(e.message));
    console.error(e);
  }
});

function runFloors() {
  const p = spawn(process.execPath, [join(HERE, "fetch-floors.mjs")], { stdio: "inherit" });
  p.on("close", () => rebuild());
}

// --- OpenSea CLI: login por navegador (sin clave privada) + refresco de elegibilidad ---
let loginChild = null;
let eligRunning = false, eligDoneAt = 0, eligCode = null;
function startOsLogin() {
  return new Promise((resolve) => {
    if (loginChild) { try { loginChild.kill(); } catch {} loginChild = null; }
    const base = osCliBase();
    if (!base) return resolve(null);
    // un único string para el shell -> sin DeprecationWarning DEP0190 (no hay input de usuario)
    const cmd = `${base.join(" ")} login --no-browser --scopes read:eligibility`;
    const child = spawn(cmd, { shell: true });
    loginChild = child;
    let done = false, buf = "";
    const finish = (val) => { if (!done) { done = true; resolve(val); } };
    const t = setTimeout(() => finish(null), 45000);          // sin URL en 45s -> nada
    const kill = setTimeout(() => { try { child.kill(); } catch {} }, 15 * 60000); // fuga
    const scan = (d) => {
      const s = d.toString();
      process.stderr.write(s);
      buf += s;
      const m = buf.match(/https?:\/\/auth\.opensea\.io\/\S+/) || buf.match(/https?:\/\/\S+/);
      if (m) { clearTimeout(t); finish(m[0].replace(/[)\].,"'\s]+$/, "")); }
    };
    child.stdout.on("data", scan);
    child.stderr.on("data", scan);            // el CLI imprime la URL por stderr
    child.on("close", (code) => {
      loginChild = null; clearTimeout(t); clearTimeout(kill);
      console.log(`  opensea login → código ${code}`);
      finish(null);
      if (code === 0) kickElig();   // ya conectado: comprueba listas
    });
    child.on("error", (e) => { console.error("  opensea login:", e.message); loginChild = null; clearTimeout(t); finish(null); });
  });
}
function runElig() {
  return new Promise((resolve) => {
    // pásale los slugs del radar (mints en curso / inminentes) además del calendario
    const radarSlugs = [...new Set((cache?.mints || [])
      .filter((m) => (m.status === "now" || m.status === "soon") && m.slug)
      .map((m) => m.slug))].join(",");
    const args = [join(HERE, "fetch-eligibility.mjs")];
    if (radarSlugs) args.push(`--slugs=${radarSlugs}`);
    const p = spawn(process.execPath, args, { stdio: "inherit" });
    p.on("close", (code) => resolve(code ?? 1));
  });
}
// lanza la comprobación en segundo plano y marca eligRunning para que la web sepa
function kickElig() {
  if (eligRunning) return;
  eligRunning = true;
  runElig().then(async (code) => { eligRunning = false; eligDoneAt = Date.now(); eligCode = code; await rebuild(); });
}

// Solo loopback: el panel y sus endpoints (owned, opensea/login, eligibility)
// NO deben quedar expuestos a la red local.
server.listen(PORT, "127.0.0.1", () => {
  const u = `http://localhost:${PORT}/`;
  console.log(`\n🚨 Monitor MINTS  →  ${u}`);
  console.log("   Checkboxes de 'Tengo' → se guardan en data/colecciones.json");
  console.log("   Feed de mints: refresco automático cada 15 min");
  console.log(noFloors ? "   Floors: desactivados (--no-floors)" : "   Floors (OpenSea): cada 60 min");
  console.log("   Ctrl+C para parar\n");
  try { execSync(`start "" "${u}"`, { shell: "cmd.exe" }); } catch {}
});

setInterval(rebuild, 15 * 60 * 1000);            // feed de mints / popularidad
if (!noFloors) setInterval(runFloors, 60 * 60 * 1000);  // floors + histórico
