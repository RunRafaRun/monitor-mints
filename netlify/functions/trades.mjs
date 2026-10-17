// Adaptador Netlify Functions (v2) -> Pages Function de Cloudflare.
// Handler real en functions/api/trades.js. Requiere BLOCKSCOUT_API_KEY (+ OPENSEA_API_KEY para floors).
import { onRequestPost } from "../../functions/api/trades.js";

const env = new Proxy({}, { get: (_, k) => Netlify.env.get(String(k)) });

export default async (request) => onRequestPost({ request, env });
export const config = { path: "/api/trades", method: "POST" };
