# Deploying the public page

The page is static. Only `dist-site/` is ever published, never the repo root.

## Build

```sh
npm run build:site
# or, with other addresses:
SITE_URL=https://dispatch.tatinc.us MCP_URL=https://warm-wave-mr3nk.run.mcp-use.com/mcp node scripts/build-site.mjs
```

The build copies an allowlist of `site/` (html, css, js, svg, png, ico, woff2, txt, json, xml, plus `_headers`) into `dist-site/`, never `site/video/` or dotfiles. It fills `{{MCP_URL}}` and `{{SITE_URL}}`, adds `og.png`, the favicons, `robots.txt`, `sitemap.xml` and `llms.txt`, and exits non-zero if the output has a file outside the allowlist, a leftover `{{`, or an internal string (repo URL, project notes file names, `op://`, the password manager's name).

Preview locally:

```sh
python3 -m http.server -d dist-site 8081   # http://localhost:8081
```

## Deploy

`cf` (1.0.0-beta.21) has `cf pages deploy [directory]`; `cf pages deploy --help` lists only `--dry-run` as an option, and its help says the directory is "not deployed by cf", so check what it actually does with `--dry-run` first. Not run from this repo yet.

```sh
cf pages deploy dist-site --dry-run
cf pages deploy dist-site
```

If `cf` has no way to name the Pages project, the Wrangler form from the TAT checklist is:

```sh
npx wrangler pages deploy dist-site --project-name=<project> --branch=main
```

Deploy from a gated workflow, not from the dashboard's Git integration, and never `dist-site`'s parent.

## Probe after every deploy

Run against the custom domain and the `*.pages.dev` alias. Each of the first group must be 404 (or the HTML fallback), never the file:

```sh
H=https://dispatch.tatinc.us
for p in CLAUDE.md TASKS.md README.md package.json .env docs/ docs/COMPLIANCE.md src/ index.ts; do
  curl -s -o /dev/null -w "%{http_code} $p\n" "$H/$p"
done
# must be 200:
for p in robots.txt llms.txt og.png sitemap.xml favicon.svg; do
  curl -s -o /dev/null -w "%{http_code} $p\n" "$H/$p"
done
# headers
curl -sI "$H/" | grep -i -E "content-security-policy|x-frame-options|x-content-type-options|referrer-policy|cache-control"
```

Removed files stay cached on the custom domain and the alias after a redeploy; purge the zone cache if anything sensitive ever shipped.
