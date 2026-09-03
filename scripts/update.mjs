// Rutina completa en un comando.
//
//   node update.mjs            radar + slugs + floors + alerts + ranking + dashboard
//   node update.mjs --open     además abre el dashboard en el navegador
//   node update.mjs --quick    salta resolve-slugs y fetch-floors (solo radar + dashboard)
//
// Desde el Explorador: doble clic en  actualizar.cmd  (en la carpeta del proyecto).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { authFile } from "./lib/os-auth.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const quick = process.argv.includes("--quick");
const open = process.argv.includes("--open");
const pub = process.argv.includes("--public") || process.env.PUBLIC === "1";
const envKey = /OPENSEA_API_KEY=\S/.test(
  (existsSync(join(HERE, ".env")) ? readFileSync(join(HERE, ".env"), "utf8") : "")
);
const hasKey = envKey || !!process.env.OPENSEA_API_KEY;

const hasWallets = existsSync(join(HERE, "..", "data", "wallets.json"));

const steps = [
  ["Radar de mints", "gen-radar.mjs", ["--write"]],
];
if (hasKey && hasWallets) {
  steps.push(["Escaneo de wallets", "scan-wallets.mjs", ["--write"]]);
}
// elegibilidad real (WL/GTD/FCFS) de tu wallet: solo si hay sesión de OpenSea
if (!pub && existsSync(authFile())) {
  steps.push(["Elegibilidad de tu wallet (OpenSea)", "fetch-eligibility.mjs", []]);
}
if (!quick && hasKey) {
  steps.push(["Resolver slugs de OpenSea", "resolve-slugs.mjs", []]);
  steps.push(["Floors + histórico", "fetch-floors.mjs", []]);
  steps.push(["Alertas de floor", "floor-alerts.mjs", []]);
} else if (!quick && !hasKey) {
  console.log("⚠️  Sin OPENSEA_API_KEY en scripts/.env → salto floors (ver SETUP.md)\n");
}
steps.push(["Ranking de llaves", "rank.mjs", ["--write"]]);
steps.push(["Dashboard HTML", "gen-dashboard.mjs", [
  ...(pub ? ["--public"] : []),
  ...(open ? ["--open"] : []),
]]);

const t0 = Date.now();
for (const [label, script, args] of steps) {
  process.stdout.write(`\n▶ ${label}…\n`);
  const r = spawnSync(process.execPath, [join(HERE, script), ...args], { stdio: "inherit" });
  if (r.status !== 0) console.log(`  (⚠️ ${script} terminó con código ${r.status}, sigo)`);
}
console.log(`\n✅ Listo en ${((Date.now() - t0) / 1000).toFixed(0)}s → data/dashboard.html`);
