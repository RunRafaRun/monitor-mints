// Servidor local del dashboard: los checkboxes de "Tengo" se guardan en
// colecciones.json de verdad, y hay botón de Actualizar.
//
//   node serve.mjs            -> http://localhost:8787  (y lo abre en el navegador)
//   node serve.mjs --port 9000
//
// Ctrl+C para parar.
import { createServer } from "node:http";
import { execSync, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { statSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { loadCollections, saveCollections, findCollection, ROOT } from "./lib/data.mjs";
import { osCliBase, whoami, walletLabel } from "./lib/os-auth.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// scripts/.env -> MWA_WORKER_URL / MWA_AUTH_TOKEN (mismo patron que ya usan
// fetch-eligibility.mjs, etc. para OPENSEA_API_KEY)
(() => {
  const p = join(HERE, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, "");
  }
})();

// Recarga gen-dashboard.mjs si cambia en disco -> no hay que reiniciar servidor.cmd
const GD = join(HERE, "gen-dashboard.mjs");
let _gd, _gdAt = 0;
async function gd() {
  const m = statSync(GD).mtimeMs;
  if (m !== _gdAt) { _gd = await import(`${pathToFileURL(GD).href}?v=${m}`); _gdAt = m; console.log("  (gen-dashboard.mjs recargado)"); }
  return _gd;
}
const argv = process.argv.slice(2);
const PORT = Number(argv[argv.indexOf("--port") + 1]) || 8787;
const noFloors = argv.includes("--no-floors");
// Por defecto solo loopback. Con --lan escucha en toda la red local para
// poder abrirlo desde el móvil (http://<IP-de-la-PC>:PORT). OJO: expone
// TODOS los endpoints (owned/mint/opensea) a cualquiera en la misma red.
const LAN = argv.includes("--lan");
const HOST = LAN ? "0.0.0.0" : "127.0.0.1";

let cache = null;
let building = false;
let rebuildAgain = false;
// Si rebuild() ya esta corriendo (ej. el refresco automatico de 15min) y
// se pide otro en el medio (ej. justo cuando termina "Comprobar
// elegibilidad"), antes se perdia en silencio (el segundo pedido se
// ignoraba) y la web quedaba con datos de elegibilidad desactualizados
// hasta el proximo ciclo. Ahora se encola UNO mas para cuando termine el
// que esta corriendo, en vez de descartarlo.
async function rebuild() {
  if (building) { rebuildAgain = true; return; }
  building = true;
  try { cache = await (await gd()).buildData(); }
  catch (e) { console.error("build:", e.message); }
  finally {
    building = false;
    if (rebuildAgain) { rebuildAgain = false; rebuild(); }
  }
}
rebuild(); // primera carga en segundo plano

const LOADING = `<!doctype html><meta charset=utf-8><meta http-equiv=refresh content=3>
<body style="font:15px system-ui;background:#0f1115;color:#e7e9ee;padding:40px">
mintscope_ — cargando datos (feed + floors)… <br><br>se recarga sola.</body>`;

const server = createServer(async (req, res) => {
  const path = req.url.split("?")[0];
  try {
    if (path === "/") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      return res.end(cache ? (await gd()).html(cache, { served: true }) : LOADING);
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

    // ---- Puente hacia mint-world-architecture: mintear/programar/cancelar
    // en Cloudflare lo que este radar ya detecto. Camino separado del resto
    // de este servidor (no toca collections/floors/opensea-login de arriba).
    // Solo loopback (ver server.listen mas abajo), igual que todo lo demas.
    if (path === "/mint") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      return res.end(readFileSync(join(HERE, "..", "web", "mint-actions.html"), "utf8"));
    }
    if (path === "/api/mint/schedule" && req.method === "POST") {
      let body = ""; for await (const chunk of req) body += chunk;
      res.setHeader("content-type", "application/json");
      try {
        const parsed = JSON.parse(body || "{}");
        const result = await mwaSchedule(parsed);
        if (result.ok) recordScheduled(parsed, result);
        return res.end(JSON.stringify(result));
      } catch (e) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    }
    if (path === "/api/mint/status" && req.method === "GET") {
      res.setHeader("content-type", "application/json");
      const q = new URL(req.url, "http://x").searchParams;
      try {
        const result = await mwaProxy("status", "GET", null, q.get("project"), q.get("scheduler"));
        return res.end(JSON.stringify(result));
      } catch (e) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    }
    if (path === "/api/mint/cancel" && req.method === "POST") {
      const q = new URL(req.url, "http://x").searchParams;
      res.setHeader("content-type", "application/json");
      try {
        const result = await mwaProxy("cancel", "POST", null, q.get("project"), q.get("scheduler"));
        if (result.ok && q.get("project")) forgetScheduled(q.get("project"), q.get("scheduler"));
        return res.end(JSON.stringify(result));
      } catch (e) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    }
    // El radar borra sola la entrada del registro local cuando un "Estado"
    // devuelve un estado terminal (minted/error/needs-manual-review) para
    // no seguir mostrando "programado" sobre algo que ya termino.
    if (path === "/api/mint/forget" && req.method === "POST") {
      const q = new URL(req.url, "http://x").searchParams;
      res.setHeader("content-type", "application/json");
      if (q.get("project")) forgetScheduled(q.get("project"), q.get("scheduler"));
      return res.end(JSON.stringify({ ok: true }));
    }

    res.statusCode = 404;
    res.end("not found");
  } catch (e) {
    res.statusCode = 500;
    res.end(String(e.message));
    console.error(e);
  }
});

// --- Puente hacia mint-world-architecture (Cloudflare Worker ya desplegado) ---
// Config al vuelo a partir de contract+chain (el radar ya los trae) — no
// hace falta crear un configs/*.json por proyecto como en mint-world-
// architecture. Solo las chains que ya tenemos RPC verificado; el resto
// (base/monad/solana) se rechaza con un error claro, no se adivina.
const MWA_CHAINS = {
  robinhood: {
    chainId: 4663,
    rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
    rpcUrls: ["https://robinhood-rpc.publicnode.com", "https://robinhood-mainnet.core.chainstack.com/2062c74fba5dc620ff757d6d5fc05ce4"],
  },
  ethereum: {
    chainId: 1,
    rpcUrl: "https://ethereum-rpc.publicnode.com",
    rpcUrls: ["https://cloudflare-eth.com"],
  },
  // RPCs tomados del config ya validado de Moni-Bot (mismo dueño, en uso
  // real) — arc/ink no tenian RPC propio verificado aca todavia, lo que
  // bloqueaba "Programar" para ~74 proyectos en arc y 2 en ink del radar.
  // El camino GTD/FCFS/WL (via API de OpenSea) no depende de un contrato
  // SeaDrop fijo, asi que es de bajo riesgo; el camino PUBLIC (mintPublic
  // directo) asume la misma direccion de SeaDrop que Robinhood/Ethereum —
  // no verificado en Arc/Ink todavia, revisar si falla ahi.
  arc: {
    chainId: 5042,
    rpcUrl: "https://rpc.mainnet.arc.io",
    rpcUrls: ["https://rpc.drpc.mainnet.arc.io", "https://rpc.quicknode.mainnet.arc.io", "https://rpc.blockdaemon.mainnet.arc.io"],
  },
  ink: {
    chainId: 57073,
    rpcUrl: "https://rpc-gel.inkonchain.com",
    rpcUrls: ["https://rpc-qnd.inkonchain.com", "https://rpc-mainnet.inkonchain.com", "https://ink.drpc.org"],
  },
};
const MWA_SEADROP_CONTRACT = "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5";
const MWA_FEE_RECIPIENT = "0x0000a26b00c1F0DF003000390027140000fAa719";

function mwaChainConfig(chain) {
  const c = MWA_CHAINS[chain];
  if (!c) throw new Error(`Chain '${chain}' todavia no tiene RPC verificado para mintear (solo robinhood/ethereum por ahora).`);
  return c;
}

// El slug de OpenSea de fetch-eligibility.mjs trae el uuid de cada fase;
// el radar de Trencher (buildData) NO lo trae, asi que se busca aparte en
// data/eligibility-wallet.json en vez de tocar gen-dashboard.mjs.
function findStageUuid(slug, kind) {
  const p = join(ROOT, "data", "eligibility-wallet.json");
  if (!existsSync(p)) throw new Error("No hay data/eligibility-wallet.json todavia — corre 'Comprobar elegibilidad' primero.");
  const we = JSON.parse(readFileSync(p, "utf8"));
  const stages = we.drops?.[slug]?.stages || [];
  const hit = stages.find((s) => s.kind === kind && s.eligible);
  if (!hit) throw new Error(`No se encontro una fase ${kind} elegible para '${slug}' en eligibility-wallet.json.`);
  return hit.uuid;
}

async function mwaProxy(action, method, body, project, scheduler) {
  if (!process.env.MWA_AUTH_TOKEN) throw new Error("Falta MWA_AUTH_TOKEN en scripts/.env.");
  if (!project) throw new Error("Falta 'project'.");
  const url = new URL(process.env.MWA_WORKER_URL || "https://mint-scheduler.unpin.workers.dev");
  url.searchParams.set("project", project);
  url.searchParams.set("action", action);
  if (scheduler) url.searchParams.set("scheduler", scheduler);
  const res = await fetch(url, {
    method,
    headers: { "x-auth-token": process.env.MWA_AUTH_TOKEN, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return res.json();
}

async function mwaSchedule({
  chain, contract, slug, kind, quantity, gasMultiplier, waitUntil,
  template, merkleProof, allowlistPricePerToken, allowlistCurrency, allowlistQuantityLimitPerWallet,
  conditions, expiresAt, minPriorityFeeWei,
}) {
  if (!contract) throw new Error("Falta 'contract'.");
  const chainCfg = mwaChainConfig(chain);
  const isGtd = !!kind && kind !== "PUBLIC";
  const project = String(contract).toLowerCase();
  const body = {
    quantity: Number(quantity) || 1,
    gasMultiplier: Number(gasMultiplier) || 100,
  };
  if (waitUntil) body.targetTimestamp = Math.floor(new Date(waitUntil).getTime() / 1000);
  // Suelo minimo de propina (wei) opcional — ver applyPriorityFeeFloor en
  // cloudflare/src/index.mjs. Solo se activa si se manda explicitamente
  // (opt-in), para mints disputados por bots donde gasMultiplier solo no
  // basta porque puede estar multiplicando un maxPriorityFeePerGas de 0.
  const withPriorityFloor = (cfg) => (minPriorityFeeWei != null ? { ...cfg, minPriorityFeeWei: String(minPriorityFeeWei) } : cfg);

  // Disparo por condicion de mercado (supply%/restante, o precio de
  // reventa vs precio de mint via Seaport) en vez de una hora fija —
  // camino separado, ver ConditionMintScheduler en cloudflare/src/index.mjs.
  // Puede mintear via SeaDrop estandar o via una plantilla conocida
  // (template) por debajo, igual que el camino normal/custom.
  if (Array.isArray(conditions) && conditions.length) {
    body.conditions = conditions;
    if (expiresAt) body.expiresAt = Math.floor(new Date(expiresAt).getTime() / 1000);
    if (template) {
      body.config = withPriorityFloor({ chainId: chainCfg.chainId, rpcUrl: chainCfg.rpcUrl, rpcUrls: chainCfg.rpcUrls, nftContract: contract, template });
      if (Array.isArray(merkleProof) && merkleProof.length) {
        body.merkleProof = merkleProof;
        if (allowlistPricePerToken != null) body.allowlistPricePerToken = allowlistPricePerToken;
        if (allowlistCurrency) body.allowlistCurrency = allowlistCurrency;
        if (allowlistQuantityLimitPerWallet != null) body.allowlistQuantityLimitPerWallet = allowlistQuantityLimitPerWallet;
      }
    } else {
      body.config = withPriorityFloor({
        chainId: chainCfg.chainId, rpcUrl: chainCfg.rpcUrl, rpcUrls: chainCfg.rpcUrls,
        nftContract: contract, seaDropContract: MWA_SEADROP_CONTRACT, feeRecipient: MWA_FEE_RECIPIENT,
      });
    }
    return mwaProxy("schedule", "POST", body, project, "condition");
  }

  // Plantilla conocida (thirdweb DropERC721, etc.) — camino separado del
  // resto, para contratos de "sitio propio" que no pasan ni por SeaDrop
  // ni por OpenSea. Sin verificar todavia contra un contrato real (ver el
  // comentario en cloudflare/src/index.mjs, CustomMintScheduler).
  if (template) {
    body.config = withPriorityFloor({ chainId: chainCfg.chainId, rpcUrl: chainCfg.rpcUrl, rpcUrls: chainCfg.rpcUrls, nftContract: contract, template });
    if (Array.isArray(merkleProof) && merkleProof.length) {
      body.merkleProof = merkleProof;
      if (allowlistPricePerToken != null) body.allowlistPricePerToken = allowlistPricePerToken;
      if (allowlistCurrency) body.allowlistCurrency = allowlistCurrency;
      if (allowlistQuantityLimitPerWallet != null) body.allowlistQuantityLimitPerWallet = allowlistQuantityLimitPerWallet;
    }
    return mwaProxy("schedule", "POST", body, project, "custom");
  }

  if (isGtd) {
    if (!slug) throw new Error("Falta 'slug' de OpenSea para programar una fase GTD/FCFS/WL.");
    body.config = withPriorityFloor({ chainId: chainCfg.chainId, rpcUrl: chainCfg.rpcUrl, rpcUrls: chainCfg.rpcUrls });
    body.slug = slug;
    body.stageUuid = findStageUuid(slug, kind);
    return mwaProxy("schedule", "POST", body, project, "gtd");
  }

  body.config = withPriorityFloor({
    chainId: chainCfg.chainId,
    rpcUrl: chainCfg.rpcUrl,
    rpcUrls: chainCfg.rpcUrls,
    nftContract: contract,
    seaDropContract: MWA_SEADROP_CONTRACT,
    feeRecipient: MWA_FEE_RECIPIENT,
  });
  return mwaProxy("schedule", "POST", body, project, null);
}

// Registro local de "lo que programe desde esta web" (contract+scheduler ->
// detalle) para poder pintar un aviso "programado" en el radar sin tener
// que golpear el Durable Object de cada uno de los ~160 proyectos en cada
// carga de pagina. No sabe de mints programados desde la GUI de escritorio
// (esa usa el mismo Worker pero no escribe aca) — solo cubre lo hecho via
// esta web (/, /mint). Se borra la entrada al cancelar o cuando el Worker
// confirma "minted"/"cancelled"/"error" en un chequeo de estado (ver
// pruneScheduledIfDone en gen-dashboard.mjs, llamado desde el propio modal).
const scheduledLedgerPath = join(ROOT, "data", "scheduled-mints.json");
function loadScheduledLedger() {
  try { return JSON.parse(readFileSync(scheduledLedgerPath, "utf8")); } catch { return {}; }
}
function saveScheduledLedger(ledger) {
  try { writeFileSync(scheduledLedgerPath, JSON.stringify(ledger, null, 2) + "\n"); } catch {}
}
function recordScheduled({ chain, contract, name, slug, kind, quantity, gasMultiplier, template, conditions }, result) {
  if (!contract) return;
  const scheduler = conditions?.length ? "condition" : template ? "custom" : (!!kind && kind !== "PUBLIC") ? "gtd" : null;
  const key = `${String(contract).toLowerCase()}:${scheduler || "public"}`;
  const ledger = loadScheduledLedger();
  ledger[key] = {
    contract: String(contract).toLowerCase(), chain, name: name || null, slug: slug || null,
    kind: kind || "PUBLIC", scheduler, template: template || null, conditions: conditions || null,
    quantity: Number(quantity) || 1, gasMultiplier: Number(gasMultiplier) || 100,
    targetTimestamp: result.targetTimestamp || null, scheduledAt: Date.now(),
  };
  saveScheduledLedger(ledger);
}
const KNOWN_SCHEDULERS = new Set(["gtd", "custom", "condition"]);
function forgetScheduled(project, scheduler) {
  const key = `${String(project).toLowerCase()}:${KNOWN_SCHEDULERS.has(scheduler) ? scheduler : "public"}`;
  const ledger = loadScheduledLedger();
  if (ledger[key]) { delete ledger[key]; saveScheduledLedger(ledger); }
}

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
server.listen(PORT, HOST, () => {
  const u = `http://localhost:${PORT}/`;
  console.log(`\n  mintscope_  →  ${u}`);
  if (LAN) console.log(`   Móvil (misma WiFi) →  http://${lanIp()}:${PORT}/`);
  console.log("   Checkboxes de 'Tengo' → se guardan en data/colecciones.json");
  console.log("   Feed de mints: refresco automático cada 15 min");
  console.log(noFloors ? "   Floors: desactivados (--no-floors)" : "   Floors (OpenSea): cada 60 min");
  console.log("   Ctrl+C para parar\n");
  try { execSync(`start "" "${u}"`, { shell: "cmd.exe" }); } catch {}
});

// IP de la PC en la red local (IPv4 no-loopback, prioriza Wi-Fi/Ethernet).
function lanIp() {
  const skip = (n) => /loopback|WSL|Hyper-V|vEthernet|virtual|VMware|VirtualBox|Tailscale|ZeroTier/i.test(n);
  const out = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    if (skip(name)) continue;
    for (const a of addrs || []) if (a.family === "IPv4" && !a.internal) out.push(a.address);
  }
  return out[0] || "localhost";
}

setInterval(rebuild, 15 * 60 * 1000);            // feed de mints / popularidad
if (!noFloors) setInterval(runFloors, 60 * 60 * 1000);  // floors + histórico
