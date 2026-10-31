// One-off, read-only inspection of Brave's submit page. Does NOT type or click anything.
import puppeteer from "puppeteer";
const browser = await puppeteer.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const resp = await page.goto("https://search.brave.com/submit-url", { waitUntil: "domcontentloaded", timeout: 30000 });
  console.log("HTTP", resp?.status(), page.url());
  await new Promise((r) => setTimeout(r, 4000));
  const info = await page.evaluate(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
    const attrs = (e) => Object.fromEntries([...e.attributes].filter(a => !/^(value|style)$/.test(a.name)).map(a => [a.name, a.value.slice(0, 80)]));
    return {
      title: document.title,
      headings: [...document.querySelectorAll("h1,h2,h3")].map(h => h.tagName + ": " + h.textContent.trim()),
      inputs: [...document.querySelectorAll("input,textarea,select")].map(e => ({ tag: e.tagName, visible: vis(e), disabled: e.disabled, attrs: attrs(e), label: e.labels?.[0]?.textContent?.trim() ?? null })),
      buttons: [...document.querySelectorAll("button,[role=button],input[type=submit]")].map(e => ({ tag: e.tagName, visible: vis(e), disabled: e.disabled, text: e.textContent.trim().slice(0, 60), attrs: attrs(e) })),
      forms: [...document.querySelectorAll("form")].map(f => ({ attrs: attrs(f) })),
      iframes: [...document.querySelectorAll("iframe")].map(f => f.src.slice(0, 100)),
      bodyText: document.body.innerText.slice(0, 1500),
    };
  });
  console.log(JSON.stringify(info, null, 2));
  await page.screenshot({ path: process.env.TMPDIR + "/brave-submit-before.png" });
  console.log("screenshot:", process.env.TMPDIR + "/brave-submit-before.png");
} finally { await browser.close(); }
