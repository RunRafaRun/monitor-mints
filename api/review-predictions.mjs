import { onRequestGet, onRequestPost } from "../functions/api/review-predictions.js";

const env = new Proxy({}, { get: (_, k) => process.env[String(k)] });
const fake = (req) => ({
  json: () => Promise.resolve(req.body ?? {}),
  text: () => Promise.resolve(JSON.stringify(req.body ?? {})),
  method: req.method,
  url: "http://localhost" + req.url,
  headers: { get: (k) => req.headers[k.toLowerCase()] ?? null },
});

export default async (req, res) => {
  const ctx = { request: fake(req), env };
  const r = await (req.method === "POST" ? onRequestPost(ctx) : onRequestGet(ctx));
  res.status(r.status).json(await r.json());
};
