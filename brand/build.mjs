// Builds the brand assets from the Runway/Recraft vector mark (brand/runway/mark-recraft.svg).
// node brand/build.mjs  -> brand/mark.svg, brand/favicon.svg and PNGs in brand/out/
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const dir = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(dir, "runway/mark-recraft.svg"), "utf8");
const paths = [...src.matchAll(/<path[^>]*d="([^"]+)"/g)].map((m) => m[1]);
const [, bracket, arrow] = paths; // [0] is the full-canvas background tile
const nums = (d) => [...d.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
const pts = [...nums(bracket), ...nums(arrow)];
const xs = pts.filter((_, i) => i % 2 === 0), ys = pts.filter((_, i) => i % 2 === 1);
const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
const w = x1 - x0, h = y1 - y0, pad = Math.max(w, h) * 0.08;
const vb = `${(x0 - pad).toFixed(1)} ${(y0 - pad - (w - h) / 2).toFixed(1)} ${(w + 2 * pad).toFixed(1)} ${(w + 2 * pad).toFixed(1)}`;
const INK = "#e4e4e7", LIME = "#8ee476", BG = "#0c0c0e";
const glyph = (ink, accent) => `<path fill="${ink}" d="${bracket}"/><path fill="${accent}" d="${arrow}"/>`;

fs.writeFileSync(path.join(dir, "mark.svg"), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" role="img" aria-label="Indexing Dispatch">${glyph(INK, LIME)}</svg>\n`);
fs.writeFileSync(path.join(dir, "mark-dark-ink.svg"), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" role="img" aria-label="Indexing Dispatch">${glyph(BG, "#2f7a1f")}</svg>\n`);
const tile = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="${BG}"/><svg x="28" y="28" width="456" height="456" viewBox="${vb}">${glyph(INK, LIME)}</svg></svg>\n`;
fs.writeFileSync(path.join(dir, "favicon.svg"), tile);

const fontCss = (f, fam, w) => `@font-face{font-family:'${fam}';src:url('data:font/woff2;base64,${fs.readFileSync(path.join(dir, "..", "views/render-submission-canvas/fonts", f)).toString("base64")}') format('woff2');font-weight:${w};}`;
const css = `${fontCss("syne-latin-800-normal.woff2", "Syne", 800)}${fontCss("jetbrains-mono-latin-wght-normal.woff2", "JBM", "100 800")}
*{margin:0;box-sizing:border-box}body{background:${BG};color:${INK};}
.word{font-family:Syne,Arial Black,sans-serif;font-weight:800;text-transform:uppercase;letter-spacing:-.04em;line-height:.9}
svg{flex:none}
.tag{font-family:JBM,monospace;text-transform:uppercase;letter-spacing:.2em;opacity:.65}`;
const markSvg = (size) => `<svg width="${size}" height="${size}" viewBox="${vb}">${glyph(INK, LIME)}</svg>`;
const pages = {
  "logo-lockup.png": [1600, 520, `<div style="display:flex;align-items:center;gap:56px;padding:70px 90px;height:520px">${markSvg(300)}<div><div class="word" style="font-size:132px">Indexing<br>Dispatch</div><div class="tag" style="font-size:24px;margin-top:28px">URL submission // AI-readiness audit</div></div></div>`],
  "logo-stacked.png": [1000, 1000, `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:40px;height:1000px">${markSvg(420)}<div class="word" style="font-size:110px;text-align:center">Indexing<br>Dispatch</div><div class="tag" style="font-size:20px">URL submission // AI-readiness audit</div></div>`],
  "og.png": [1200, 630, `<div style="display:flex;align-items:center;gap:56px;padding:0 70px;height:630px;background-image:radial-gradient(circle at 2px 2px,rgba(228,228,231,.1) 1px,transparent 0);background-size:32px 32px">${markSvg(230)}<div><div class="word" style="font-size:92px">Indexing<br>Dispatch</div><div class="tag" style="font-size:19px;margin-top:24px">Send your pages to search. See what each one said.</div></div></div>`],
};
const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
const shot = async (name, wpx, hpx, body) => {
  await page.setViewport({ width: wpx, height: hpx });
  await page.setContent(`<style>${css}</style>${body}`, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(dir, "out", name) });
};
for (const [name, [wpx, hpx, body]] of Object.entries(pages)) await shot(name, wpx, hpx, body);
for (const s of [16, 32, 48, 180, 192, 512]) await shot(`favicon-${s}.png`, s, s, `<div style="width:${s}px;height:${s}px;display:flex">${tile.replace('<svg xmlns', `<svg width="${s}" height="${s}" xmlns`)}</div>`);
await browser.close();
console.log("brand assets built");
