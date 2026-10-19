import { onRequestPost } from "../functions/api/trades.js";

const env = new Proxy({}, { get: (_, k) => process.env[String(k)] });

export default async (request) => onRequestPost({ request, env });
