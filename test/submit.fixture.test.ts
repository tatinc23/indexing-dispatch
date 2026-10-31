/**
 * Drives the REAL submit flow in real Chromium against local fixture pages that imitate
 * Brave's submit page. Input/button structure mirrors what was observed live on
 * 2026-10-25 (input#url autocomplete=url; disabled button[name=captcha-button] "Submit").
 * The success/failure states are fixtures, not captures of Brave's real responses.
 * Nothing here contacts Brave.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import puppeteer, { type Browser } from "puppeteer";
import { toToolResult } from "../src/format.js";
import { BRAVE_SUBMIT_URL, submitToBrave, type Timings } from "../src/submit.js";

const FAST: Partial<Timings> = {
  totalBudgetMs: 20_000,
  navigationMs: 5_000,
  uiReadyMs: 2_500,
  minSettleMs: 600,
  observeMs: 4_000,
  challengePersistMs: 1_200,
  pollMs: 100,
};

const page = (scenario: string) => `<!doctype html><html><body><main>
<form id="f"><p>Insert the URL to be re-fetched</p>
<input id="url" type="text" autocomplete="url" placeholder="Enter a valid url" required>
<button name="captcha-button" id="btn" disabled>Submit</button></form>
<div id="out"></div>
<footer>Brave Search uses private usage metrics to estimate overall activity and performance.</footer></main>
<script>
const scenario = ${JSON.stringify(scenario)};
const input = document.getElementById('url'), btn = document.getElementById('btn'), out = document.getElementById('out');
input.addEventListener('input', () => { btn.disabled = !/^https?:\\/\\/[^.]+\\.[^.]+/.test(input.value); });
const success = () => { btn.textContent = 'Submitted'; btn.disabled = true; out.innerHTML = '<section><h2>Success</h2><p>Thank you for your submission.</p></section>'; };
if (scenario === 'brave-like') { // mirrors the live flow observed 2026-10-25: passive verify on load and after click; "Success" is a plain div
  btn.textContent = 'Verifying...'; out.textContent = "Verifying you're a human being";
  setTimeout(() => { btn.textContent = 'Submit'; btn.disabled = !/^https?:\\/\\/[^.]+\\.[^.]+/.test(input.value); out.textContent = ''; }, 800);
}
document.getElementById('f').addEventListener('submit', (e) => {
  e.preventDefault();
  btn.textContent = 'Submitting…'; btn.disabled = true;
  if (scenario === 'accepted') setTimeout(success, 300);
  if (scenario === 'brave-like') { out.textContent = "Verifying you're a human being"; btn.textContent = 'Verifying...'; setTimeout(() => { out.innerHTML = '<div><div>Success</div><div>Thank you for your submission.</div></div>'; btn.textContent = 'Submitted'; }, 2200); }
  if (scenario === 'accepted-after-checking') { out.textContent = 'Checking…'; setTimeout(() => { out.textContent = ''; success(); }, 1800); }
  if (scenario === 'rejected') setTimeout(() => { out.innerHTML = '<div role="alert" class="error">Something went wrong. Please try again later.</div>'; btn.textContent = 'Submit'; btn.disabled = false; }, 300);
  if (scenario === 'verification') setTimeout(() => { out.innerHTML = '<p>Please confirm: I\\'m not a robot</p>'; }, 300);
  if (scenario === 'message-only') setTimeout(() => { out.innerHTML = '<p>Thank you for your submission.</p>'; btn.textContent = 'Submit'; }, 300);
  if (scenario === 'nav') setTimeout(() => { location.href = '/done'; }, 300);
  if (scenario === 'offorigin') setTimeout(() => { location.href = 'http://localhost:' + location.port + '/elsewhere'; }, 300);
  // 'timeout': nothing else happens
});
</script></body></html>`;

let server: Server;
let base: string;
let browsers: Browser[] = [];

before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const send = (code: number, body: string) => res.writeHead(code, { "content-type": "text/html" }).end(body);
    if (url.pathname === "/done") return send(200, "<!doctype html><main><h2>Success</h2><p>Thank you for your submission.</p><button disabled>Submitted</button></main>");
    if (url.pathname === "/elsewhere") return send(200, "<!doctype html><p>somewhere else</p>");
    if (url.pathname === "/http500") return send(500, "boom");
    if (url.pathname === "/http429") return send(429, "slow down");
    if (url.pathname === "/noinput") return send(200, "<!doctype html><p>layout changed</p><button>Submit</button>");
    return send(200, page(url.searchParams.get("scenario") ?? "timeout"));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  server.close();
  await Promise.all(browsers.map((b) => b.close().catch(() => undefined)));
});

const run = (path: string, target = "https://example.com/", timings: Partial<Timings> = {}) =>
  submitToBrave(target, { submitPageUrl: `${base}${path}`, timings: { ...FAST, ...timings } });

describe("submitToBrave against fixtures (real Chromium)", () => {
  it("never points at anything but Brave by default", () => {
    assert.equal(BRAVE_SUBMIT_URL, "https://search.brave.com/submit-url");
  });

  it("accepted: SPA update, honours the minimum settle time", async () => {
    const { result, clicked, screenshot } = await run("/?scenario=accepted");
    assert.equal(result.status, "accepted");
    assert.equal(clicked, true);
    assert.match(result.confirmationText ?? "", /Success.*Thank you for your submission/);
    assert.match(result.message, /not a guarantee/i);
    assert.ok(result.durationMs >= FAST.minSettleMs!, `duration ${result.durationMs}`);
    assert.equal(screenshot, undefined);
    assert.equal(toToolResult(result).isError, undefined);
  });

  it("accepted: Brave-faithful flow (passive 'Verifying…' before and after click, plain-div 'Success')", async () => {
    const { result } = await run("/?scenario=brave-like", undefined, { challengePersistMs: 300, observeMs: 6_000 });
    assert.equal(result.status, "accepted");
    assert.equal(result.confirmationText, "Success Thank you for your submission.");
  });

  it("accepted: transient 'Checking…' text is not mistaken for a verification challenge", async () => {
    const { result } = await run("/?scenario=accepted-after-checking", undefined, { challengePersistMs: 500 });
    assert.equal(result.status, "accepted");
  });

  it("accepted: full-page navigation is handled without a navigation wait", async () => {
    const { result } = await run("/?scenario=nav");
    assert.equal(result.status, "accepted");
  });

  it("rejected: explicit error alert, with diagnostics and screenshot", async () => {
    const { result, screenshot } = await run("/?scenario=rejected");
    assert.equal(result.status, "rejected");
    assert.match(result.message, /Something went wrong/);
    assert.equal(result.diagnostics?.screenshotAttached, true);
    assert.ok(screenshot && screenshot.length > 100);
    const tool = toToolResult(result, screenshot);
    assert.equal(tool.isError, true);
    assert.equal(tool.content[1]?.type, "image");
  });

  it("verification_required: a human challenge that persists", async () => {
    const { result } = await run("/?scenario=verification");
    assert.equal(result.status, "verification_required");
    assert.match(result.message, /will not attempt to solve/);
  });

  it("timeout: nothing definitive happens", async () => {
    const { result, clicked } = await run("/?scenario=timeout", undefined, { observeMs: 1_500 });
    assert.equal(result.status, "timeout");
    assert.equal(clicked, true);
    assert.match(result.message, /may or may not have been received/);
  });

  it("timeout (ambiguous): message without a Success heading or 'Submitted' button is not accepted", async () => {
    const { result } = await run("/?scenario=message-only", undefined, { observeMs: 1_800 });
    assert.equal(result.status, "timeout");
    assert.match(result.message, /unconfirmed/);
  });

  it("error: navigating away from the submit page aborts the run", async () => {
    const { result } = await run("/?scenario=offorigin");
    assert.equal(result.status, "error");
    assert.equal(result.errorCode, "unexpected_navigation");
  });

  it("error: HTTP 500 and 429 on the submit page, without clicking anything", async () => {
    const a = await run("/http500");
    assert.equal(a.result.errorCode, "http_error");
    assert.equal(a.clicked, false);
    const b = await run("/http429");
    assert.match(b.result.message, /rate-limiting/);
  });

  it("error: input missing (layout change)", async () => {
    const { result, clicked } = await run("/noinput");
    assert.equal(result.errorCode, "input_not_found");
    assert.equal(clicked, false);
  });

  it("error: Submit never enables for a value the page won't accept; nothing is clicked", async () => {
    const { result, clicked } = await run("/?scenario=accepted", "https://nodot");
    assert.equal(result.errorCode, "submit_button_disabled");
    assert.equal(clicked, false);
  });

  it("error: browser launch failure is caught and explained", async () => {
    const { result } = await submitToBrave("https://example.com/", {
      launch: async () => {
        throw new Error("Failed to launch the browser process! No usable sandbox!");
      },
    });
    assert.equal(result.status, "error");
    assert.equal(result.errorCode, "browser_launch_failed");
    assert.match(result.message, /BRAVE_SUBMITTER_NO_SANDBOX/);
  });

  it("error: unreachable submit page", async () => {
    const { result } = await submitToBrave("https://example.com/", {
      submitPageUrl: "http://127.0.0.1:1/",
      timings: FAST,
    });
    assert.equal(result.errorCode, "navigation_failed");
  });

  it("always closes the browser, on success and on failure", async () => {
    for (const path of ["/?scenario=accepted", "/noinput"]) {
      let launched: Browser | undefined;
      await submitToBrave("https://example.com/", {
        submitPageUrl: `${base}${path}`,
        timings: FAST,
        launch: async () => {
          launched = await puppeteer.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
          browsers.push(launched);
          return launched;
        },
      });
      assert.equal(launched?.connected, false, `browser left open for ${path}`);
    }
  });

  it("types exactly the requested URL (no fallback to another input)", async () => {
    const target = "https://example.org/some/path?x=1";
    const { result } = await run("/?scenario=accepted", target);
    assert.equal(result.status, "accepted");
    assert.equal(result.targetUrl, target);
  });
});
