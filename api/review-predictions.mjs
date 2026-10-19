import { onRequestGet, onRequestPost } from "../functions/api/review-predictions.js";

const env = new Proxy({}, { get: (_, k) => process.env[String(k)] });

export default async (request) => {
  const ctx = { request, env };
  return request.method === "POST" ? onRequestPost(ctx) : onRequestGet(ctx);
};
