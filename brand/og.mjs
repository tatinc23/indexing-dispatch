// Renders the share card (brand/og.html, Air Mail look) to brand/out/og.png at 1200x630.
// node brand/og.mjs   (brand/build.mjs no longer draws og.png)
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import puppeteer from "puppeteer";

const dir = path.dirname(fileURLToPath(import.meta.url));
const browser = await puppeteer.launch({ headless: true, args: ["--allow-file-access-from-files"] });
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 630 });
await page.goto(pathToFileURL(path.join(dir, "og.html")).href, { waitUntil: "load" });
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: path.join(dir, "out", "og.png") });
await browser.close();
console.log("og.png built");
