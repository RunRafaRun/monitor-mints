// Adaptador Netlify Functions (v2) -> Pages Function de Cloudflare.
// Handler real en functions/api/review-predictions.js.
//
// AVISO: requiere almacenamiento KV (binding "PREDICTIONS" en Cloudflare). En
// Netlify no existe ese binding, así que devuelve 503 "not_configured" y no
// revisa nada. Es una tarea interna (no visible al visitante); si se quiere
// conservar, hay que portarla a Netlify Blobs.
import { onRequestGet, onRequestPost } from "../../functions/api/review-predictions.js";

const env = new Proxy({}, { get: (_, k) => Netlify.env.get(String(k)) });

export default async (request) => {
  const ctx = { request, env };
  return request.method === "POST" ? onRequestPost(ctx) : onRequestGet(ctx);
};
export const config = { path: "/api/review-predictions" };
