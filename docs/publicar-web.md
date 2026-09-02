# Publicar el dashboard en la web (gratis)

Objetivo: una URL que puedas pasar a un grupo, donde **todos ven los mismos datos**
(radar de mints + ranking de llaves + floors) y **nadie ve tu cartera**.

## Cómo funciona

- El dashboard público es el mismo `data/dashboard.html`, pero generado con
  `node scripts/gen-dashboard.mjs --public` (o `PUBLIC=1`). Ese modo **elimina del
  HTML** todo lo personal: `owned`, wallets, `holdings`, la cabecera "👛 N llaves".
- **Los datos son estáticos**: van "horneados" en el HTML cuando se genera. El
  visitante NO llama a ninguna API ni puede forzar un refresco — **no hay botón de
  Actualizar** en esta versión (solo aparece en el servidor local `serve.mjs`).
- La actualización la hace **el sistema**: un workflow de GitHub Actions
  (`.github/workflows/build.yml`) regenera el HTML **cada 15 min** con tus claves
  (guardadas como *Secrets*, nunca en el HTML) y lo republica. Coste: 0 € en repo
  público (Actions ilimitado; ~2-3 min/run).
- La página lleva un `<meta http-equiv="refresh" content="900">`: si alguien deja
  la pestaña abierta, se recarga sola cada 15 min y coge la última versión.
- Cada visitante puede marcar "lo que tiene" en la pestaña **Llaves**: se guarda
  solo en el `localStorage` de su navegador, no se comparte ni se sube a ningún sitio.

## Puesta en marcha — GitHub Pages (repo público)

1. **Crea el repo y sube el proyecto**
   ```bash
   cd "C:\Users\rfernandez\Monitor MINTS"
   git init
   git add .
   git commit -m "Monitor MINTS"
   gh repo create monitor-mints --public --source=. --push
   ```
   `.gitignore` ya excluye lo sensible: `scripts/.env`, `data/wallets.json`,
   `data/holdings.json`, `data/dashboard.html`, cachés. Verifícalo antes del push:
   ```bash
   git status --ignored
   ```

2. **Añade las claves como Secrets**
   Repo → *Settings* → *Secrets and variables* → *Actions* → *New repository secret*:
   - `OPENSEA_API_KEY` — tu clave de OpenSea
   - `WLMT_URL` y `WLMT_KEY` — los valores de `scripts/.env` (opcionales; si no los
     pones, esa segunda fuente simplemente se ignora)

3. **Activa Pages**
   Repo → *Settings* → *Pages* → *Build and deployment* → *Source*: **GitHub Actions**.

4. **Lanza el primer build**
   Repo → *Actions* → *build-dashboard* → *Run workflow*.
   Al terminar, la URL sale en el job `deploy`:
   `https://<usuario>.github.io/monitor-mints/`

A partir de ahí se regenera solo cada 15 min. Para cambiar la frecuencia, edita el
`cron` en `.github/workflows/build.yml` (y el `content="900"` del meta-refresh en
`gen-dashboard.mjs` si quieres que la recarga del navegador vaya al mismo ritmo).

> GitHub Actions puede retrasar las ejecuciones programadas unos minutos cuando hay
> carga; en la práctica el intervalo real suele ser de 15 a 25 min.

## Si prefieres repo PRIVADO

GitHub Pages desde repo privado necesita plan de pago. Además, en repo privado los
minutos de Actions gratis son 2000/mes: a un build cada 15 min **no caben** (harían
falta ~8600). Opciones: subir el `cron` a `"*/45 * * * *"`, o —mejor— usar repo
**público** solo para que Actions sea ilimitado y desplegar a un host externo.

Alternativas gratis: quita del workflow los dos jobs `build`/`deploy` y usa **un
solo job** que genera y despliega. El paso de generación es idéntico (`node update.mjs` con
`PUBLIC=1` y los secrets); solo cambia el final:

### Cloudflare Pages  → `https://monitor-mints.pages.dev`
```yaml
      - name: Preparar sitio
        run: mkdir -p site && cp data/dashboard.html site/index.html
      - uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          command: pages deploy site --project-name=monitor-mints
```
`CLOUDFLARE_API_TOKEN`: en el panel de Cloudflare → *My Profile* → *API Tokens* →
plantilla "Edit Cloudflare Workers" (o permiso *Account · Cloudflare Pages · Edit*).
Con **Cloudflare Access** (gratis hasta 50 usuarios) puedes además poner una puerta
de contraseña/email si quieres restringir quién entra.

### Netlify  → `https://<sitio>.netlify.app`
```yaml
      - name: Preparar sitio
        run: mkdir -p site && cp data/dashboard.html site/index.html
      - run: npx --yes netlify-cli deploy --dir=site --prod
        env:
          NETLIFY_AUTH_TOKEN: ${{ secrets.NETLIFY_AUTH_TOKEN }}
          NETLIFY_SITE_ID: ${{ secrets.NETLIFY_SITE_ID }}
```

## Notas

- En CI no existe `data/mint-floors.json` (caché de muestras de floor), así que el
  "ritmo real +N/15m" arranca en modo estimación hasta que haya 2 ejecuciones
  seguidas. Si quieres el histórico entre runs, cachea `data/` con `actions/cache`.
- El servidor interactivo (`serve.mjs`) **no** se publica: sigue siendo para ti en
  local, donde los checkboxes se guardan de verdad en `colecciones.json`.
