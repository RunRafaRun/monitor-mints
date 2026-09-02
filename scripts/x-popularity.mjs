// Ficha de popularidad de un proyecto a partir de su cuenta de X.
//
// Con X_BEARER_TOKEN (API v2) en scripts/.env  -> rellena las métricas.
// Sin token                                    -> imprime la plantilla en blanco.
//
// Uso:  node x-popularity.mjs elonmusk
//       node x-popularity.mjs @SomeProject
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
loadEnv(join(HERE, ".env"));

const handle = (process.argv[2] || "").replace(/^@/, "").trim();
if (!handle) { console.error("Uso: node x-popularity.mjs <handle>"); process.exit(1); }

const TOKEN = process.env.X_BEARER_TOKEN;
if (!TOKEN) {
  console.log(blankCard(handle));
  console.log("\n(sin X_BEARER_TOKEN: rellena a mano. Alta: https://developer.x.com/)");
  process.exit(0);
}

const h = { authorization: `Bearer ${TOKEN}` };
const u = await fetch(
  `https://api.x.com/2/users/by/username/${handle}?user.fields=public_metrics,created_at,description`,
  { headers: h }
).then((r) => r.json());

if (!u?.data) { console.error("No encontrado:", JSON.stringify(u)); process.exit(1); }
const { id, public_metrics: pm, created_at } = u.data;

const tw = await fetch(
  `https://api.x.com/2/users/${id}/tweets?max_results=20&tweet.fields=public_metrics,created_at&exclude=retweets,replies`,
  { headers: h }
).then((r) => r.json());

const posts = tw?.data || [];
const now = Date.now();
const d30 = posts.filter((t) => now - Date.parse(t.created_at) < 30 * 86400000);
const avg = (k) => posts.length ? Math.round(posts.reduce((s, t) => s + (t.public_metrics[k] || 0), 0) / posts.length) : 0;
const likeAvg = avg("like_count"), rtAvg = avg("retweet_count"), replyAvg = avg("reply_count");
const followers = pm.followers_count;
const erate = followers ? (((likeAvg + rtAvg + replyAvg) / followers) * 100) : 0;
const ageMonths = Math.round((now - Date.parse(created_at)) / (30 * 86400000));

const verdict =
  followers > 10000 && erate > 2 && ageMonths >= 4 ? "🟢 ALTO" :
  followers > 2000 && erate > 1 ? "🟡 MEDIO" : "🔴 BAJO / REVISAR";

console.log(`📊 @${handle} — POPULARITY CHECK
Cuenta X: @${handle}  ·  creada: ${created_at.slice(0, 7)}  (~${ageMonths} meses)
Seguidores: ${followers.toLocaleString("en-US")}
Siguiendo: ${pm.following_count.toLocaleString("en-US")}  ·  Tweets totales: ${pm.tweet_count.toLocaleString("en-US")}
Posts últimos 30d (sin RT/replies): ${d30.length}  ·  ritmo: ~${(d30.length / 30).toFixed(1)}/día
Engagement medio (últimos ${posts.length}): ${likeAvg} likes · ${rtAvg} RT · ${replyAvg} replies
Engagement rate: ${erate.toFixed(2)} %

VEREDICTO: ${verdict}`);

function blankCard(handle) {
  return `📊 @${handle} — POPULARITY CHECK  (rellenar a mano)
Cuenta X: @${handle}  ·  creada: ____
Seguidores: ____  (↑ ____ / 7d)
Posts (30d): ____  ·  ritmo: ____/día
Engagement medio (últimos 10): ____ likes · ____ RT · ____ replies
Engagement rate: ____ %
Discord: ____ miembros
VEREDICTO: 🟢 ALTO / 🟡 MEDIO / 🔴 BAJO`;
}

function loadEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, "");
  }
}
