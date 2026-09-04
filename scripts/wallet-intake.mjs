// Procesa un issue "[cartera] 0x…": saca la dirección, la añade a
// data/community-wallets.json, comenta y cierra el issue.
//
// Lo llama .github/workflows/wallet-intake.yml. Env que espera:
//   ISSUE  número del issue
//   TITLE  título del issue
//   BODY   cuerpo del issue
//   GH_TOKEN  token con permiso issues:write (github.token)
//   GITHUB_REPOSITORY  owner/repo (lo pone Actions)
//   GITHUB_OUTPUT      fichero de outputs (lo pone Actions)
//
// Outputs:  added=1|0 · addr=0x…  (si added=1, el workflow commitea y dispara
// el cálculo).

import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIST = join(HERE, "..", "data", "community-wallets.json");
const ADDR_RE = /0x[0-9a-fA-F]{40}/;
const CAP = 300;                       // tope de direcciones en la lista

const ISSUE = process.env.ISSUE;
const repo = process.env.GITHUB_REPOSITORY || "";
const text = `${process.env.TITLE || ""}\n${process.env.BODY || ""}`;

function setOut(k, v) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);
  console.log(`${k}=${v}`);
}
function gh(args) {
  try { execFileSync("gh", args, { stdio: "inherit" }); }
  catch (e) { console.error(`gh ${args.join(" ")} falló: ${e.message}`); }
}
function replyClose(body) {
  if (!ISSUE) { console.log("(sin ISSUE; no comento)"); return; }
  gh(["issue", "comment", ISSUE, "-R", repo, "--body", body]);
  gh(["issue", "close", ISSUE, "-R", repo]);
}
const done = (added, addr = "") => { setOut("added", added ? "1" : "0"); setOut("addr", addr); process.exit(0); };

const m = text.match(ADDR_RE);
if (!m) {
  replyClose("No encontré ninguna dirección `0x…` de 42 caracteres. Usa el botón **Apúntala aquí** de la pestaña Cartera del dashboard.");
  done(false);
}
const addr = m[0].toLowerCase();

let raw = { wallets: [] };
if (existsSync(LIST)) { try { raw = JSON.parse(readFileSync(LIST, "utf8")); } catch { /**/ } }
const list = Array.isArray(raw) ? raw : (raw.wallets || []);
const norm = list
  .map((x) => String(typeof x === "string" ? x : x?.address || "").trim().toLowerCase())
  .filter((a) => /^0x[0-9a-f]{40}$/.test(a));

if (norm.includes(addr)) {
  replyClose(`\`${addr}\` ya estaba en la lista. Abre el dashboard → pestaña **Cartera** → escribe tu dirección.`);
  done(false);
}
if (norm.length >= CAP) {
  replyClose(`La lista está llena (${CAP}). Prueba más tarde o abre un issue pidiendo ampliarla.`);
  done(false);
}

const wallets = [...norm, addr];
const out = Array.isArray(raw) ? wallets : { ...raw, wallets };
writeFileSync(LIST, JSON.stringify(out, null, 2) + "\n");

const pages = repo
  ? `https://${repo.split("/")[0]}.github.io/${repo.split("/")[1]}/#wallet=${addr}`
  : "el dashboard";
replyClose(`✅ Añadida \`${addr}\`. En unos minutos podrás verla aquí: ${pages}\n\n(pestaña **Cartera**; si aún no sale, vuelve a pulsar «Ver cartera»).`);
done(true, addr);
