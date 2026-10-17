// Adaptador Netlify Functions (v2) -> Pages Function de Cloudflare.
// El handler real sigue en functions/api/analyze.js (sin cambios de lógica).
// En Netlify no hay binding Workers AI ni KV: se usa GEMINI_API_KEY y se omite
// el guardado de predicciones (ambos caminos ya están guardados con `if`).
import { onRequestPost } from "../../functions/api/analyze.js";

const env = new Proxy({}, { get: (_, k) => Netlify.env.get(String(k)) });

export default async (request) => onRequestPost({ request, env });
export const config = { path: "/api/analyze", method: "POST" };
