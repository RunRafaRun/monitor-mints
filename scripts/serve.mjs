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
import { loadCollections, saveCollections, findCollection } from "./lib/data.mjs";

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

server.listen(PORT, () => {
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
