// The Browser Run adapter (src/worker/brave-browser-run.ts) on Node: the platform calls are injected, the flow is the
// shared one (src/submit-core.ts) driven by a local Chromium against a fixture page. Nothing contacts Brave or Cloudflare.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import puppeteer from "puppeteer";
import type { BrowserLike } from "../src/submit-core.js";
import { submitViaBrowserRun } from "../src/worker/brave-browser-run.js";

const FIXTURE = `<!doctype html><html><body><form id="f"><input id="url" type="text" autocomplete="url" placeholder="Enter a valid url">
<button id="btn" disabled>Submit</button></form><div id="out"></div><script>
const i=document.getElementById('url'),b=document.getElementById('btn'),o=document.getElementById('out');
i.addEventListener('input',()=>{b.disabled=!/^https?:\\/\\/[^.]+\\.[^.]+/.test(i.value);});
document.getElementById('f').addEventListener('submit',(e)=>{e.preventDefault();b.disabled=true;setTimeout(()=>{o.innerHTML='<div><div>Success</div><div>Thank you for your submission.</div></div>';b.textContent='Submitted';},300);});
</script></body></html>`;

let server: Server;
let base: string;
before(async () => {
  server = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end(FIXTURE));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const FAST = { totalBudgetMs: 20_000, navigationMs: 5_000, uiReadyMs: 2_500, minSettleMs: 600, observeMs: 4_000, challengePersistMs: 1_200, pollMs: 100 };

describe("submitViaBrowserRun", () => {
  it("refuses plainly without launching when the platform has no browser to hand out", async () => {
    let launched = false;
    const out = await submitViaBrowserRun("https://example.com/", {} as never, {
      limits: async () => ({ allowedBrowserAcquisitions: 0, timeUntilNextAllowedBrowserAcquisition: 12_500 }),
      launch: async () => {
        launched = true;
        throw new Error("must not launch");
      },
    });
    assert.equal(launched, false);
    assert.equal(out.clicked, false);
    assert.equal(out.browserMs, 0);
    assert.equal(out.result.status, "error");
    assert.equal(out.result.errorCode, "busy");
    assert.equal(out.result.retryAfterSeconds, 13);
    assert.match(out.result.message, /Nothing was sent to Brave/);
  });

  it("runs the shared flow end to end, reports accepted, closes the browser and measures browser time", async () => {
    let closed = false;
    const out = await submitViaBrowserRun("https://example.com/page", {} as never, {
      limits: async () => ({ allowedBrowserAcquisitions: 3, timeUntilNextAllowedBrowserAcquisition: 0 }),
      launch: async () => {
        const b = await puppeteer.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
        const close = b.close.bind(b);
        b.close = async () => {
          closed = true;
          await close();
        };
        return b as unknown as BrowserLike;
      },
      submitPageUrl: `${base}/submit-url`,
      timings: FAST,
    });
    assert.equal(out.result.status, "accepted", JSON.stringify(out.result));
    assert.equal(out.clicked, true);
    assert.equal(closed, true);
    assert.ok(out.browserMs > 0 && out.browserMs < 20_000, String(out.browserMs));
  });

  it("reports a launch refusal from the platform as browser_launch_failed with a plain hint", async () => {
    const out = await submitViaBrowserRun("https://example.com/", {} as never, {
      limits: async () => ({ allowedBrowserAcquisitions: 1, timeUntilNextAllowedBrowserAcquisition: 0 }),
      launch: async () => {
        throw new Error("429 Too Many Requests: browser time limit exceeded");
      },
    });
    assert.equal(out.result.errorCode, "browser_launch_failed");
    assert.match(out.result.message, /refused a new browser .*nothing was sent to Brave/);
    assert.equal(out.clicked, false);
  });
});
