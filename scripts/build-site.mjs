#!/usr/bin/env node
// Builds the public page: copies an allowlist of site/ into dist-site/, fills the
// {{MCP_URL}} / {{SITE_URL}} placeholders, adds brand assets and crawler files,
// then fails the build if anything unexpected ended up in the output.
// No dependencies. Node 22+.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { renderMorePlacesPage } from "./more-places.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const siteDir = join(root, "site");
const outDir = join(root, "dist-site");

const MCP_URL = (process.env.MCP_URL || "https://dispatch-mcp.tatinc.us/mcp").trim();
const SITE_URL = (process.env.SITE_URL || "https://dispatch.tatinc.us").trim().replace(/\/+$/, "");
for (const [k, v] of [["MCP_URL", MCP_URL], ["SITE_URL", SITE_URL]]) {
  if (!/^https:\/\/[^\s{}"'<>]+$/.test(v)) fail(`${k} must be an https URL without spaces, braces or quotes (got "${v}")`);
}

const ALLOWED_EXT = new Set([".html", ".css", ".js", ".svg", ".png", ".ico", ".woff2", ".txt", ".json", ".xml"]);
const TEXT_EXT = new Set([".html", ".css", ".js", ".txt", ".xml", ".json"]); // placeholders are replaced here
const EXTRA_FILES = new Set(["_headers"]); // the one allowed file without an extension
const SKIP_TOP_DIRS = new Set(["video"]);
const FORBIDDEN = ["github.com/tatinc23", "CLAUDE.md", "TASKS", "DECISIONS", "op://"];
// The one org link allowed on the page: the public source repo, exactly (not -private, not a subpath).
const ALLOWED_REPO_LINK = /https:\/\/github\.com\/tatinc23\/indexing-dispatch(?![\w.\/-])/g;
const FORBIDDEN_CI = ["1password"]; // case-insensitive

function fail(msg) {
  console.error(`build-site FAILED: ${msg}`);
  process.exit(1);
}

const fill = (s) => s.replaceAll("{{MCP_URL}}", MCP_URL).replaceAll("{{SITE_URL}}", SITE_URL);

function copyTree(srcDir, destDir, top) {
  for (const name of readdirSync(srcDir)) {
    if (name.startsWith(".")) continue; // dotfiles never ship
    const src = join(srcDir, name);
    const st = statSync(src);
    if (st.isDirectory()) {
      if (top && SKIP_TOP_DIRS.has(name)) continue;
      copyTree(src, join(destDir, name), false);
      continue;
    }
    const ext = extname(name).toLowerCase();
    const isHeaders = top && EXTRA_FILES.has(name);
    if (!ALLOWED_EXT.has(ext) && !isHeaders) continue;
    mkdirSync(destDir, { recursive: true });
    const dest = join(destDir, name);
    if (TEXT_EXT.has(ext)) writeFileSync(dest, fill(readFileSync(src, "utf8")));
    else cpSync(src, dest);
  }
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
copyTree(siteDir, outDir, true);

// The manifest is served at both well-known locations (one source file: site/mcp.json).
mkdirSync(join(outDir, ".well-known"), { recursive: true });
cpSync(join(outDir, "mcp.json"), join(outDir, ".well-known", "mcp.json"));

// Brand assets
const brandFiles = [
  ["brand/out/og.png", "og.png"],
  ["brand/favicon.svg", "favicon.svg"],
  ...[16, 32, 48, 180, 192, 512].map((n) => [`brand/out/favicon-${n}.png`, `favicon-${n}.png`]),
];
for (const [from, to] of brandFiles) {
  const src = join(root, from);
  if (!existsSync(src)) fail(`missing brand asset ${from}`);
  cpSync(src, join(outDir, to));
}

// Crawler files
writeFileSync(join(outDir, "robots.txt"), fill(`User-agent: *\nAllow: /\n\nSitemap: {{SITE_URL}}/sitemap.xml\n`));
writeFileSync(
  join(outDir, "sitemap.xml"),
  fill(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>{{SITE_URL}}/</loc></url>\n  <url><loc>{{SITE_URL}}/more-places</loc></url>\n  <url><loc>{{SITE_URL}}/privacy</loc></url>\n  <url><loc>{{SITE_URL}}/terms</loc></url>\n</urlset>\n`),
);

// /more-places: a static list of directories no agent can submit to, from src/more-places.json.
writeFileSync(join(outDir, "more-places.html"), fill(renderMorePlacesPage(JSON.parse(readFileSync(join(root, "src", "more-places.json"), "utf8")), SITE_URL)));
writeFileSync(
  join(outDir, "llms.txt"),
  fill(`# Indexing Dispatch

> A free tool for your website. Paste your link, copy a ready-made prompt, drop it into your AI app. It sends a page to Brave Search and Viesearch, checks how ready your site is for AI and search, then tells you what each one actually said. A Brave result of "accepted" means Brave confirmed it received the URL, not that the page is indexed. A Viesearch result of "accepted" means Viesearch confirmed it received the URL, not that the site is listed.

Indexing Dispatch is an MCP server run by TAT Inc. Its address is {{MCP_URL}} (streamable HTTP, no sign-in). You add it once as a custom server in Claude, Codex, Cursor or ChatGPT (Business, Enterprise and Edu, on the web). It is not affiliated with Brave or Viesearch.

## Page

- [Try it](https://{{SITE_URL_HOST}}/#try): paste your link and copy a ready-made prompt (check the site then send it to Brave and Viesearch, just send to Brave, or just send to Viesearch).
- [What is Viesearch?](https://{{SITE_URL_HOST}}/#viesearch): a plain-English explainer. Viesearch is a human-reviewed directory; the tool fills its form with your URL and email and stops instead of solving any human check.
- [Plug it in once](https://{{SITE_URL_HOST}}/#connect): step 1, setup steps for Claude, Codex, Cursor and ChatGPT.
- [The four tools](https://{{SITE_URL_HOST}}/#tools): submit-brave-url, audit-site, submit-viesearch-url, render-submission-canvas.
- [What you'll get back](https://{{SITE_URL_HOST}}/#expect): the Brave and Viesearch statuses (accepted, verification_required, rejected, timeout, error) and what each means.
- [More places to submit yourself](https://{{SITE_URL_HOST}}/more-places): directories no agent can submit to, with each one's own submit link.
- [Privacy](https://{{SITE_URL_HOST}}/privacy): what the server logs. The page has no cookies and no analytics.
- [Terms](https://{{SITE_URL_HOST}}/terms): only submit pages you own or have permission to submit.

## Contact

- emailme@tatinc.us
`).replaceAll("https://{{SITE_URL_HOST}}", SITE_URL),
);

// Gate: nothing outside the allowlist, no leftover placeholders, no internal strings.
const problems = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const rel = relative(outDir, p).split(sep).join("/");
    if (statSync(p).isDirectory()) { walk(p); continue; }
    const ext = extname(name).toLowerCase();
    if (name.startsWith(".")) problems.push(`dotfile in output: ${rel}`);
    else if (!ALLOWED_EXT.has(ext) && rel !== "_headers") problems.push(`file outside allowlist: ${rel}`);
    if (rel.startsWith("video/")) problems.push(`video in output: ${rel}`);
    if (ext === ".png" || ext === ".woff2" || ext === ".ico") continue; // binary: extension check only
    const text = readFileSync(p, "utf8");
    if (text.includes("{{")) problems.push(`leftover "{{" in ${rel}`);
    const gated = text.replace(ALLOWED_REPO_LINK, "");
    for (const f of FORBIDDEN) if (gated.includes(f)) problems.push(`forbidden string "${f}" in ${rel}`);
    const lower = text.toLowerCase();
    for (const f of FORBIDDEN_CI) if (lower.includes(f)) problems.push(`forbidden string "${f}" in ${rel}`);
  }
}
walk(outDir);
if (problems.length) fail("\n  " + problems.join("\n  "));

const count = [];
(function list(d) { for (const n of readdirSync(d)) { const p = join(d, n); statSync(p).isDirectory() ? list(p) : count.push(relative(outDir, p)); } })(outDir);
console.log(`build-site: ${count.length} files -> dist-site/ (MCP_URL=${MCP_URL}, SITE_URL=${SITE_URL})`);
console.log("build-site: OK, allowlist, placeholder and forbidden-string checks passed");
