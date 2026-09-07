# Publicar el dashboard en la web (gratis)

Objetivo: una URL que puedas pasar a un grupo, donde **todos ven los mismos datos**
(radar de mints + ranking de llaves + floors) y **nadie ve tu cartera**.

## Cómo funciona

- El sitio tiene dos piezas: la **landing** estática `web/index.html` se sirve en
  `mintscope.fun/` y el **radar** (`data/dashboard.html`) en `mintscope.fun/app/`.
  El workflow copia `web/` a la raíz y el dashboard a `/app/`.
- El dashboard público es el mismo `data/dashboard.html`, pero generado con
  `node scripts/gen-dashboard.mjs --public` (o `PUBLIC=1`). Ese modo **elimina del
  HTML** todo lo personal: `owned`, wallets, `holdings`, la cabecera "👛 N llaves",
  la pestaña Cartera y la barra de OpenSea.
- **Los datos son estáticos**: van "horneados" en el HTML cuando se genera. El
  visitante NO llama a ninguna API ni puede forzar un refresco — **no hay botón de
  Actualizar** en esta versión (solo aparece en el servidor local `serve.mjs`).
- La actualización la hace **el sistema**: un workflow de GitHub Actions
  (`.github/workflows/build.yml`) regenera el HTML **cada 10 min** con tus claves
  (guardadas como *Secrets*, nunca en el HTML) y lo despliega en **Cloudflare
  Pages**. Coste: 0 € (Actions ilimitado en repo público, ~2-3 min/run; Cloudflare
  Pages gratis con peticiones y ancho de banda ilimitados). GitHub estrangula los
  cron con carga, así que el intervalo real suele quedar en 10-20 min.
- La página lleva un `<meta http-equiv="refresh" content="600">`: si alguien deja
  la pestaña abierta, se recarga sola cada 10 min y coge la última versión.
- Cada visitante puede marcar "lo que tiene" en la pestaña **Llaves**: se guarda
  solo en el `localStorage` de su navegador, no se comparte ni se sube a ningún sitio.

> **¿Por qué GitHub construye y Cloudflare hospeda?** Cloudflare Pages solo
> reconstruye en `git push` o vía Deploy Hook, nunca en un cron propio, y su plan
> gratis tiene un tope de 500 builds/mes (un build cada 10 min son ~4.300/mes, no
> cabe). GitHub Actions sí tiene cron y minutos ilimitados en repo público, así que
> hace el `node update.mjs` cada 10 min y solo empuja el HTML resultante a Pages.

## Puesta en marcha — Cloudflare Pages (repo público)

1. **Crea el repo y sube el proyecto** (si aún no está en GitHub)
   ```bash
   cd "C:\Users\rfernandez\Monitor MINTS"
   git init
   git add .
   git commit -m "Monitor MINTS"
   gh repo create monitor-mints --public --source=. --push
   ```
   `.gitignore` ya excluye lo sensible: `scripts/.env`, `data/wallets.json`,
   `data/holdings.json`, `data/trades.json`, `data/eligibility-wallet.json`,
   `data/dashboard.html`, cachés. Verifícalo antes del push:
   ```bash
   git status --ignored
   ```

2. **Crea el proyecto de Pages** (una sola vez)
   - Panel de Cloudflare → *Workers & Pages* → *Create* → *Pages* →
     *Upload assets* (Direct Upload) → nombre del proyecto: **`monitor-mints`**.
     No hace falta subir nada ahora; con crearlo basta.
   - O por consola: `npx wrangler pages project create monitor-mints --production-branch=master`.
   - El nombre del proyecto debe coincidir con `--project-name=monitor-mints` del
     workflow. La rama de producción tiene que ser **`master`** (la de este repo).

3. **Añade los Secrets en GitHub**
   Repo → *Settings* → *Secrets and variables* → *Actions* → *New repository secret*:
   | Secret | De dónde sale |
   |---|---|
   | `OPENSEA_API_KEY` | tu clave de OpenSea (ya la tenías) |
   | `WLMT_URL` / `WLMT_KEY` | `scripts/.env` (opcionales; si faltan, esa fuente se ignora) |
   | `CLOUDFLARE_API_TOKEN` | panel CF → *My Profile* → *API Tokens* → plantilla **"Edit Cloudflare Workers"** (o permiso *Account · Cloudflare Pages · Edit*) |
   | `CLOUDFLARE_ACCOUNT_ID` | panel CF → *Workers & Pages* → *Account ID* (barra derecha) |

4. **Lanza el primer build**
   Repo → *Actions* → *build-dashboard* → *Run workflow*.
   Al terminar, el sitio está en `https://monitor-mints.pages.dev` (y, una vez
   configurado el dominio, en `https://mintscope.fun`).

A partir de ahí se regenera solo cada 10 min. Para cambiar la frecuencia, edita el
`cron` en `.github/workflows/build.yml` (y el `content="600"` del meta-refresh en
`gen-dashboard.mjs` si quieres que la recarga del navegador vaya al mismo ritmo).
`*/5` es el mínimo que admite GitHub pero rara vez lo cumple; `*/10` es el punto dulce.

### Dominio propio — `mintscope.fun` (registrado en Nominalia)

El dominio es solo para esto, así que lo más limpio es **mover el DNS a
Cloudflare** (gratis): así funciona el dominio raíz `mintscope.fun` (Nominalia no
hace *CNAME flattening* en la raíz, un CNAME a pelo ahí no vale) y encima tienes
SSL, caché y analítica.

1. Panel de Cloudflare → *Add a site* → `mintscope.fun` → plan **Free**.
2. Cloudflare escanea los DNS actuales y te da **2 nameservers** (algo como
   `xxx.ns.cloudflare.com`).
3. En el panel de **Nominalia** → dominio `mintscope.fun` → *Servidores DNS* /
   *Nameservers* → sustituye los de Nominalia por los 2 de Cloudflare. Guarda.
   (La propagación tarda de minutos a unas horas; Cloudflare te manda un email al
   activarse.)
4. Ya en Cloudflare, proyecto `monitor-mints` → *Custom domains* → *Set up a
   domain* → añade `mintscope.fun` y también `www.mintscope.fun`. Cloudflare crea
   los registros solo y emite el certificado HTTPS (unos minutos).

**Si prefieres NO tocar los nameservers** (dejar el DNS en Nominalia): solo podrás
usar un subdominio. En Nominalia añade un **CNAME** `app` →
`monitor-mints.pages.dev`, y en Cloudflare añade el custom domain
`app.mintscope.fun`. La raíz `mintscope.fun` se queda sin usar (o rebota a `app`
si Nominalia permite un redirect).

### Restringir quién entra (opcional)

**Cloudflare Access** (gratis hasta 50 usuarios): proyecto → *Settings* → habilitar
Access, y creas una política de "one-time PIN" por email o lista de correos. Pone
una pantalla de login delante del dashboard sin tocar el HTML.

## Alternativa — GitHub Pages

Si prefieres no depender de Cloudflare, el workflow anterior (`build` +
`upload-pages-artifact` + `deploy-pages`) sirve el mismo `site/index.html` en
`https://<usuario>.github.io/monitor-mints/`. Necesita *Settings → Pages → Source:
GitHub Actions* y los `permissions` `pages: write` / `id-token: write`. El
histórico de este repo tiene esa versión si hace falta volver.

## Alternativa — Netlify  → `https://<sitio>.netlify.app`
```yaml
      - name: Preparar sitio
        run: mkdir -p site && cp data/dashboard.html site/index.html
      - run: npx --yes netlify-cli deploy --dir=site --prod
        env:
          NETLIFY_AUTH_TOKEN: ${{ secrets.NETLIFY_AUTH_TOKEN }}
          NETLIFY_SITE_ID: ${{ secrets.NETLIFY_SITE_ID }}
```

## Repo PRIVADO

GitHub Pages desde repo privado necesita plan de pago, y los minutos de Actions
gratis bajan a 2000/mes (a un build cada 10-15 min **no caben**). Con el despliegue
a Cloudflare Pages el repo puede ser privado igualmente, pero sube el `cron` a
`"*/45 * * * *"` para no pasarte de esos 2000 min. Repo **público** = Actions
ilimitado y es lo que hace que el ritmo de 10 min salga gratis.

## Y si algún día quieres cartera pública / botón Actualizar de verdad

Eso ya no cabe en un HTML estático: haría falta un **Cloudflare Worker** que sirva
los datos como JSON (con las claves como *secrets* del Worker), **Workers KV o D1**
para cachear floors e histórico, y un **Cron Trigger** para refrescar cada 10-15
min sin gastar cuota de build. El `fetch-trades.mjs` es lento (~30 s/wallet por los
límites de Blockscout), así que iría en el Cron/Queue, no en la petición del
visitante. Es un rediseño mediano; el paso actual (estático en Pages) no lo
bloquea.

## Notas

- En CI no existe `data/mint-floors.json` (caché de muestras de floor), así que el
  "ritmo real +N/15m" arranca en modo estimación hasta que haya 2 ejecuciones
  seguidas. Si quieres el histórico entre runs, cachea `data/` con `actions/cache`.
- El servidor interactivo (`serve.mjs`) **no** se publica: sigue siendo para ti en
  local, donde los checkboxes se guardan de verdad en `colecciones.json`.
