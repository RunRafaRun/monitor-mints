import { onRequestGet } from "../functions/api/wallet.js";

const env = new Proxy({}, { get: (_, k) => process.env[String(k)] });
const fake = (req) => ({
  json: () => Promise.resolve({}),
  method: req.method,
  url: "http://localhost" + req.url,
  headers: { get: (k) => req.headers[k.toLowerCase()] ?? null },
});

export default async (req, res) => {
  const r = await onRequestGet({ request: fake(req), env });
  res.status(r.status).json(await r.json());
};
