// Adaptador Netlify Functions (v2) -> Pages Function de Cloudflare.
// Handler real en functions/api/wallet.js. Requiere OPENSEA_API_KEY.
import { onRequestGet } from "../../functions/api/wallet.js";

const env = new Proxy({}, { get: (_, k) => Netlify.env.get(String(k)) });

export default async (request) => onRequestGet({ request, env });
export const config = { path: "/api/wallet", method: "GET" };
