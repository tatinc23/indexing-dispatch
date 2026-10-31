// Builds the inputs the Cloudflare Workers entry (src/worker/index.ts) bundles:
//   src/worker/generated/views-manifest.json  the canvas view with its JS and CSS inlined (`mcp-use build --inline`)
//   src/worker/generated/view-assets.json     public/ files (server icon) as base64, served by mcp-use from memory
// Then restores the normal (external-assets) Node build in .mcp-use/build unless --no-restore is passed.
// Usage: node scripts/build-worker.mjs && cd deploy/mcp && npx wrangler@latest deploy
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const run = (args) => execFileSync("npx", ["mcp-use", ...args], { cwd: root, stdio: "inherit" });
const types = { ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".webp": "image/webp" };

run(["build", "--inline"]);
const manifest = JSON.parse(readFileSync(join(root, ".mcp-use/build/manifest.json"), "utf8"));
for (const [name, entry] of Object.entries(manifest.views ?? {})) {
  if (entry.kind !== "inline") throw new Error(`view ${name} was not built inline`);
}
const assets = {};
for (const file of readdirSync(join(root, "public"))) {
  const type = types[extname(file).toLowerCase()];
  if (!type) continue; // allowlist: images only
  assets[`public/${file}`] = { body: readFileSync(join(root, "public", file)).toString("base64"), contentType: type };
}
const out = join(root, "src/worker/generated");
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "views-manifest.json"), JSON.stringify(manifest.views));
writeFileSync(join(out, "view-assets.json"), JSON.stringify(assets));
console.log(`[build-worker] views: ${Object.keys(manifest.views).join(", ")}; assets: ${Object.keys(assets).join(", ") || "none"}`);
if (!process.argv.includes("--no-restore")) run(["build"]);
