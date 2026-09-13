// Endpoint temporal de diagnóstico — se borra después de la prueba.
export async function onRequestGet() {
  const testImg = "https://pbs.twimg.com/profile_images/2094948567819386881/ZTvYq9yI_normal.jpg";
  const out = {};

  try {
    const r = await fetch(`https://iqdb.org/?url=${encodeURIComponent(testImg)}`, {
      headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36" },
    });
    out.iqdb = { status: r.status, finalUrl: r.url, snippet: (await r.text()).slice(0, 300) };
  } catch (e) {
    out.iqdb = { error: String(e) };
  }

  try {
    const r = await fetch(`https://saucenao.com/search.php?output_type=2&db=999&url=${encodeURIComponent(testImg)}`, {
      headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36" },
    });
    out.saucenao = { status: r.status, finalUrl: r.url, snippet: (await r.text()).slice(0, 300) };
  } catch (e) {
    out.saucenao = { error: String(e) };
  }

  return new Response(JSON.stringify(out, null, 2), { headers: { "content-type": "application/json" } });
}
