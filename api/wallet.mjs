import { onRequestGet } from "../functions/api/wallet.js";

const env = new Proxy({}, { get: (_, k) => process.env[String(k)] });

export default async (request) => onRequestGet({ request, env });
