/**
 * Drives the REAL Viesearch submit flow in real Chromium against local fixture pages that imitate
 * Viesearch's submit form. Form structure mirrors what was observed live on 2026-11-07
 * (Website URL input + optional Title/Description/Category + Email Address input + "Submit" button).
 * The confirmation UI is PROVISIONAL: no on-page confirmation has been observed yet (the maintainer's first
 * real run, 2026-11-08 by hand, reported "no clear answer" from the tool, then Viesearch emailed
 * a "Confirm Submission" step), so the accepted-state fixture shows generic success wording that
 * the provisional confirmation patterns in READ_VIESEARCH_SNAPSHOT are built to recognise.
 * "accepted" still needs that explicit confirmation; every result must also carry the
 * email-confirmation reminder. When a real confirmation page is observed, replace the fixture
 * and the patterns with it. Nothing here contacts Viesearch.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import puppeteer, { type Browser } from "puppeteer";
import { VIESEARCH_SUBMIT_URL, submitToViesearch, type Timings } from "../src/viesearch.js";

const FAST: Partial<Timings> = {
  totalBudgetMs: 20_000,
  navigationMs: 5_000,
  uiReadyMs: 2_500,
  minSettleMs: 600,
  observeMs: 4_000,
  challengePersistMs: 1_200,
  pollMs: 100,
};

const EMAIL = "visitor@example.com";

const page = (scenario: string) => `<!doctype html><html><body><main>
<h1>Submit Your Website</h1>
<form id="f"><p>Website URL</p>
<input id="url" type="text" autocomplete="url" placeholder="https://example.com" required>
<p>Title</p><input id="title" type="text" placeholder="Auto-fetch">
<p>Description</p><textarea id="desc" placeholder="Auto-fetch"></textarea>
<p>Category</p><select id="cat"><option>Blogs</option><option>Search</option></select>
<p>Email Address</p>
<input id="email" type="email" name="email" placeholder="you@example.com" required>
<button id="btn"> Submit </button></form>
<div id="out"></div>
</main>
<script>
const scenario = ${JSON.stringify(scenario)};
const url = document.getElementById('url'), email = document.getElementById('email'), btn = document.getElementById('btn'), out = document.getElementById('out');
if (scenario === 'email-mismatch') email.addEventListener('input', () => { email.value = 'changed@evil.test'; });
document.getElementById('f').addEventListener('submit', (e) => {
  e.preventDefault();
  btn.textContent = 'Submitting…'; btn.disabled = true;
  // PROVISIONAL confirmation UI (see file header): generic success wording + Success heading.
  if (scenario === 'accepted') setTimeout(() => { out.innerHTML = '<section><h2>Success</h2><p>Thank you! Your site has been received and is under review.</p></section>'; btn.textContent = 'Submitted'; }, 300);
  if (scenario === 'registered') setTimeout(() => { out.innerHTML = '<div role="alert">already a registered user</div>'; }, 300);
  if (scenario === 'verification') setTimeout(() => { out.innerHTML = '<p>Please confirm: I\\'m not a robot</p>'; }, 300);
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
    if (url.pathname === "/noemail") {
      return send(200, "<!doctype html><main><form><input id=\"url\" type=\"text\" autocomplete=\"url\"><button>Submit</button></form></main>");
    }
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

const run = (path: string, email: string = EMAIL, timings: Partial<Timings> = {}) =>
  submitToViesearch("https://example.com/", email, { submitPageUrl: `${base}${path}`, timings: { ...FAST, ...timings } });

describe("submitToViesearch against fixtures (real Chromium)", () => {
  it("points at Viesearch's real submit page by default", () => {
    assert.equal(VIESEARCH_SUBMIT_URL, "https://viesearch.com/submit");
  });

  it("accepted: fills URL + email, leaves the rest blank, reports the confirmation", async () => {
    const { result, clicked } = await run("/?scenario=accepted");
    assert.equal(result.status, "accepted");
    assert.equal(clicked, true);
    assert.match(result.message, /Viesearch's page showed an explicit success confirmation/);
    assert.match(result.message, /not a guarantee that Viesearch will list it/);
  });

  it("accepted message reminds the user to confirm the Viesearch email", async () => {
    const { result } = await run("/?scenario=accepted");
    assert.equal(result.status, "accepted");
    assert.match(result.message, /Confirm Submission/);
    assert.match(result.message, /review queue/);
  });

  it("non-accepted outcomes still carry the email-confirmation reminder via the tool result", async () => {
    const { viesearchToolResult } = await import("../src/discovery-format.js");
    for (const path of ["/?scenario=registered", "/?scenario=verification"]) {
      const { result } = await run(path);
      const out = viesearchToolResult(result as unknown as import("../src/contract.js").ViesearchResult);
      assert.match(out.content[0]!.text, /Confirm Submission/);
      assert.match((out.structuredContent as { message: string }).message, /review queue/);
    }
  });

  it("accepted confirmation is the page's text, and the email is redacted everywhere", async () => {
    const { result, screenshot } = await run("/?scenario=accepted");
    assert.equal(screenshot, undefined);
    assert.equal(result.diagnostics, undefined); // contract: no diagnostics on accepted
    const asJson = JSON.stringify(result);
    assert.doesNotMatch(asJson, new RegExp(EMAIL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("rejected: 'already a registered user' maps to rejected", async () => {
    const { result, screenshot } = await run("/?scenario=registered");
    assert.equal(result.status, "rejected");
    assert.match(result.message, /already a registered user/);
    assert.equal(screenshot, undefined); // screenshots off: the filled form would show the email
    assert.equal(result.diagnostics?.screenshotAttached, false);
  });

  it("verification_required: a human challenge that persists", async () => {
    const { result } = await run("/?scenario=verification");
    assert.equal(result.status, "verification_required");
    assert.match(result.message, /will not attempt to solve/);
    assert.match(result.message, /https:\/\/viesearch\.com\/submit/);
  });

  it("timeout: nothing definitive happens", async () => {
    const { result, clicked } = await run("/?scenario=timeout", EMAIL, { observeMs: 1_500 });
    assert.equal(result.status, "timeout");
    assert.equal(clicked, true);
    assert.match(result.message, /may or may not have been received by Viesearch/);
  });

  it("error: email input changed while typing aborts instead of submitting something else", async () => {
    const { result, clicked } = await run("/?scenario=email-mismatch");
    assert.equal(result.status, "error");
    assert.equal(result.errorCode, "input_mismatch");
    assert.match(result.message, /changed the email/);
    assert.equal(clicked, false);
  });

  it("error: email input missing (layout change)", async () => {
    const { result, clicked } = await run("/noemail");
    assert.equal(result.status, "error");
    assert.equal(result.errorCode, "input_not_found");
    assert.match(result.message, /email input/);
    assert.equal(clicked, false);
  });

  it("always closes the browser, on success and on failure", async () => {
    for (const path of ["/?scenario=accepted", "/noemail"]) {
      let launched: Browser | undefined;
      await submitToViesearch("https://example.com/", EMAIL, {
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
});
