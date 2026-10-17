// Adaptador Netlify Functions (v2) -> Pages Function de Cloudflare.
// Handler real en functions/api/os.js. Requiere OPENSEA_API_KEY.
import { onRequestPost } from "../../functions/api/os.js";

const env = new Proxy({}, { get: (_, k) => Netlify.env.get(String(k)) });

export default async (request) => onRequestPost({ request, env });
export const config = { path: "/api/os", method: "POST" };
