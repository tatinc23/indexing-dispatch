# Cloudflare Workers port: plan, verified facts, results (2026-10-29)

Branch `feat/cf-port` (from `feat/go-live`). Goal: run the Indexing Dispatch MCP server (same four public tools, same
contracts, same honesty rules, same public access model, same canvas) on Cloudflare Workers at
`https://dispatch-mcp.tatinc.us/mcp`, because the Manufact deployment is paused for usage. The Node/Manufact/Docker path
still works and still passes its test suite.

## 0. The most important finding: this account is on Workers Paid, not Workers Free

`GET /accounts/d6a266be.../subscriptions` (read with the shell's API token, 2026-10-29) lists **`workers_paid` "Workers Paid", $5/month**,
alongside the free zone plans. `puppeteer.limits()` on the deployed Worker agrees: `maxConcurrentSessions: 200` (the Paid
default; Free is 3). Nothing was enabled or bought tonight; the subscription already existed.

Consequences:
- Everything below ran on **Workers Paid limits**. I could not measure Workers Free behaviour on this account.
- The real Brave submission used **239 ms CPU** (the read-only Browser Run spike used 166 ms). **Workers Free allows 10 ms CPU
  per HTTP request.** So on a genuinely Free account the Brave path would very likely be cut off (Error 1102); the other tools
  measured 2-26 ms CPU per request (median 2-3 ms), so audits are borderline on Free. Unverified on Free; flagged, not guessed.
- The budgets in the code are still sized to the **Free** Browser Run allowance (10 min/day), which is also below the Paid
  included amount (10 browser hours/month, about 20 min/day), so tonight's design adds **$0** on the Paid plan as long as the
  daily cap holds.

## 1. Verified facts (source, and what I measured)

| Fact | Source / measurement |
|---|---|
| Browser Run Free: **10 min browser time per day**, **3 concurrent browsers**, **1 new browser every 20 s**, default 60 s idle timeout (`keep_alive` up to 20 min) | https://developers.cloudflare.com/browser-run/limits/ (read 2026-10-29) |
| Browser Run billing: daily totals in seconds; Paid: 10 h/month included, then $0.09 per browser hour, 10 concurrent included then $2 each; failed Quick Actions with `waitForTimeout` not charged | https://developers.cloudflare.com/browser-run/pricing/ |
| The pricing page does not say what happens on Free when the 10 minutes are used up | same page (gap: assume refusal) |
| Durable Objects on Free: **SQLite-backed only**; 100,000 requests/day, 13,000 GB-s/day, 5 M rows read, 100,000 rows written, 5 GB; exceeding a limit fails that operation type until 00:00 UTC | https://developers.cloudflare.com/durable-objects/platform/pricing/ |
| Workers Free: 100,000 requests/day, **10 ms CPU per HTTP request**, 50 subrequests, 128 MB per isolate, no hard wall-clock limit for HTTP requests, 6 simultaneous outgoing connections waiting for headers | https://developers.cloudflare.com/workers/platform/limits/ |
| `fetch()` from a Worker to a **Custom Domain** Worker on the same zone is allowed (exception to the same-zone rule) | https://developers.cloudflare.com/workers/configuration/routing/custom-domains/ ; measured: the deployed Worker fetched `https://dispatch.tatinc.us/` (audit) and the IndexNow key file there |
| DoH JSON: `GET https://cloudflare-dns.com/dns-query?name=..&type=A|AAAA`, header `accept: application/dns-json`, `Status` 0 = NOERROR, `Answer[].type/data` | https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/ ; measured from the Worker: 11 ms per query |
| Workers' network refuses private literals: `http://169.254.169.254/`, `127.0.0.1`, `10.0.0.1`, `[::1]` -> **HTTP 403 "error code: 1003"** in 1-3 ms | measured on the deployed spike Worker |
| A hostname that resolves to 127.0.0.1 (`localtest.me`) -> **HTTP 530 "error code: 1016"** | measured |
| Public IP literal (`https://1.1.1.1/cdn-cgi/trace`) is allowed (200) | measured |
| `http://example.com:8080/` from a Worker: no answer within 5 s (timeout) | measured; we allow only ports 80/443 anyway |
| mcp-use 2.11.2 ships a `workerd` export condition (`dist/index.js`, Node-only pieces stubbed) and `MCPServer.fetch` (web-standard handler); `mcp-use build --inline` embeds the view JS+CSS in the MCP resource; `registerViews(manifest, { assets })` serves `public/` files from memory | `node_modules/mcp-use/package.json`, `dist/server.d.ts`, `dist/views/types.d.ts`, `@mcp-use/cli` build command |
| mcp-use bundles for Workers only after aliasing its optional `@mcp-use/client` dynamic import | wrangler build error, fixed by `alias` in `deploy/mcp/wrangler.jsonc` |
| `@cloudflare/puppeteer` 1.4.0 (fork of puppeteer 22.13.1, CDP since 1.1.0): `launch(binding, {keep_alive})`, `limits()` (activeSessions, maxConcurrentSessions, allowedBrowserAcquisitions, timeUntilNextAllowedBrowserAcquisition), `sessions()`, `history()`, `connect()`. **No daily-usage query**, so the server meters browser time itself | `node_modules/@cloudflare/puppeteer/lib/types.d.ts`, README |
| Every Puppeteer call `src/submit.ts` uses works on Browser Run: `newPage`, `setViewport`, `on("framenavigated")`, `goto`, `evaluateHandle`/`evaluate` with string scripts, `ElementHandle.focus/type/click/evaluate/dispose`, `screenshot({encoding:"base64"})`. Not used/not available: `browser.process()` (no local process; replaced by a 5 s bounded `close()`) | real submission below |

### What Brave sees from Browser Run (spike, read-only, 2026-10-29, no submission)
- Launch 776 ms; `GET https://search.brave.com/submit-url` -> **HTTP 200** in 451 ms; title "Submit URL - Brave Search".
- URL input found, exactly one "Submit" button found (disabled until a URL is typed, as on Node), **no challenge frames or text**; classifier: `pending`.
- User agent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/152.0.0.0 Safari/537.36`
  (it says HeadlessChrome; we do not disguise it).
- Egress seen by `https://www.cloudflare.com/cdn-cgi/trace` from inside the browser: `ip=104.28.152.130`, `colo=LAX`, `loc=US`.
- Whole read-only session: 7.6 s of browser time.

## 2. Architecture

```
index.ts (Node entry, Manufact/Docker)          src/worker/index.ts (Workers entry, dispatch-mcp)
  - SubmissionGuard (per process)                 - BudgetLimiter DO "global" (src/worker/limiter-do.ts) over src/limits.ts
  - src/submit.ts  (puppeteer, local Chromium)    - src/worker/brave-browser-run.ts (@cloudflare/puppeteer, Browser Run)
  - src/safe-fetch.ts (node:http, DNS pinning)    - src/worker/safe-fetch-worker.ts (DoH + fetch, ports 80/443)
            \_____________ shared, runtime-neutral ______________/
             src/tool-defs.ts (names, descriptions, schemas, refusal results)
             src/submit-core.ts (Brave flow) + classify.ts + page-scripts.ts
             src/safe-fetch-core.ts (address rules, URL checks, redirect loop)
             src/audit.ts, src/indexnow.ts (engines; import "#safe-fetch", which package.json maps to the
               Workers guard under the "workerd" condition and to the Node guard otherwise)
             src/contract.ts, src/schema.ts, src/format.ts, src/discovery-format.ts, the canvas view
```

Logging: only the server's own one-line JSON events (no caller data); Workers invocation logs are OFF and query strings
redacted, so request headers and caller IPs are not stored (the page's privacy statement says so). CPU numbers above were
read while invocation logs were still on.

HTTP surface of the Worker: `/mcp` and `/mcp/*` (MCP streamable HTTP and the `public/` icon); `GET /` returns a small JSON
info document; a browser opening `/mcp` (Accept: text/html) is redirected to https://dispatch.tatinc.us/; everything else
is 404. All responses carry HSTS, `nosniff`, `no-referrer`, `X-Frame-Options: DENY`; non-MCP responses also carry
`Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`. `workers_dev` and preview URLs are off.

## 3. Per-tool port table

| Tool | Node (unchanged) | Workers | Status on the deployed Worker |
|---|---|---|---|
| `submit-brave-url` | puppeteer + local Chromium, per-process guard | `@cloudflare/puppeteer` on Browser Run; global DO guard incl. daily browser budget; asks `limits()` before launching | **Real submission accepted** (see section 5) |
| `submit-indexnow` | safe-fetch (Node) key check + one POST | Workers safe-fetch key check + one POST; global guard | Key verified from the Worker; IndexNow answered **HTTP 429** (see section 5) |
| `audit-site` | safe-fetch (Node) | Workers safe-fetch (DoH) | **Works** (real audit of dispatch.tatinc.us); SSRF refusals work |
| `render-submission-canvas` | view built with external assets | same view, built `--inline` (JS+CSS in the resource), icon from memory | **Props and `ui://views/render-submission-canvas.html` resource served** (693 KB HTML); not yet opened in a real Claude/ChatGPT host |
| `snapshot-cloudflare-baseline` | env-gated | **not offered** (self-host only; needs an operator token) | n/a |

## 4. State and limits (one Durable Object)

`BudgetLimiter` (SQLite-backed, `new_sqlite_classes`, one instance named `global`) persists the `BudgetLedger` from
`src/limits.ts` after every acquire/release. Durable Objects process one request at a time and confirm storage writes
before replying, so the counters are global and atomic. A refused request gets a plain sentence and `retryAfterSeconds`.

| Budget | brave | indexnow | audit |
|---|---|---|---|
| concurrent | 1 | 1 | 3 |
| per rolling hour (all callers together) | 12 | 6 | 40 |
| dedupe after it actually went out | 24 h per URL | 1 h per host + URL set | none |
| spacing between starts | 20 s (Browser Run Free rule) | - | - |
| lease (slot reclaimed if the request dies) | 150 s, then assumed sent and charged a full reservation | 60 s | 90 s |

Daily browser budget: **480 s per UTC day** (8 of the 10 free minutes; 2 min margin), **90 s reserved per run in flight**,
the measured launch-to-close time charged on release. The limiter fails closed: if the DO cannot be reached, nothing is
sent. If the DO itself ever hit its own daily quota it would also fail closed (refusal, not a silent pass).

### Limits math (how many Brave submissions per day)
- Measured real submission: 16.8 s tool time (launch to close inside it); the read-only spike session: 7.6 s.
- Typical day: a new run is allowed while `used + 90 s <= 480 s`, so with ~17 s runs: (480 - 90) / 17 + 1 = **about 23 submissions/day**.
- Worst case (every run hangs to the 75 s flow budget plus 5 s close): 480 / 80 = **6 per day** guaranteed.
- The hourly cap (12) and the 20 s spacing allow more than that, so the browser budget is the binding limit.
- On Workers Paid the included 10 h/month (~20 min/day) is above the 8 min/day cap, so there is no overage at these numbers.

## 5. Smoke tests on the deployed Worker (https://dispatch-mcp.tatinc.us/mcp, 2026-10-29)

| Test | Result |
|---|---|
| `node scripts/mcp-call.mjs .../mcp list` | 4 tools: submit-brave-url, submit-indexnow, audit-site, render-submission-canvas |
| `audit-site` https://dispatch.tatinc.us/ | `ok`, HTTP 200, title/description/canonical/lang/JSON-LD/OG read, llms.txt + sitemap present, 124 ms |
| `audit-site` http://169.254.169.254/ | `blocked` (input check: not a public host) |
| `audit-site` http://localtest.me/ | `blocked`: "localtest.me resolves to 127.0.0.1, which is not a public address (loopback)" (DoH) |
| `audit-site` http://127.0.0.1.nip.io/ | `blocked`, same reason (DoH) |
| `audit-site` http://dispatch.tatinc.us:8080/ | `blocked`: "port 8080 is not allowed (only 80 and 443)" |
| `submit-brave-url` http://10.0.0.1/ | refused by input validation |
| `render-submission-canvas` | `structuredContent` = props; `_meta.ui.resourceUri` = `ui://views/render-submission-canvas.html` |
| `resources/list` + `resources/read` of the view | `text/html;profile=mcp-app`, 692,895 chars, CSP connect/resource domains = https://dispatch-mcp.tatinc.us |
| **`submit-brave-url` https://tatinc.us/ (REAL)** | **`accepted`**, "Success Thank you for your submission.", 16.8 s; 239 ms CPU, 17.2 s wall |
| same URL again | `recently_submitted` from the global DO, no browser started |
| **`submit-indexnow` dispatch.tatinc.us, [https://dispatch.tatinc.us/] (REAL)** | key file fetched and verified from the Worker; IndexNow **HTTP 429** "too many requests (potential spam)"; reported as `rejected`, not retried. Same URL was pinged once earlier tonight from the Mac (202). |
| **`submit-indexnow` [https://dispatch.tatinc.us/llms.txt] (REAL, 2nd and last ping, 15:11 UTC)** | key verified; **HTTP 429** again with a different URL set. Both test pings used; IndexNow from the Worker is therefore unproven. |
| HTTP surface | `/` 200 JSON with security headers + CSP; unknown paths 404; `/mcp` in a browser -> 302 to the public page |

## 6. SSRF on Workers: what is ours, what is the platform's, and the residual window

Ours (`src/safe-fetch-core.ts` + `src/worker/safe-fetch-worker.ts`, unit-tested in `test/safe-fetch-worker.test.ts`):
http/https only, no userinfo, ports 80/443 only, `localhost`/`*.localhost` refused, IP literals classified
(private, loopback, link-local/metadata, CGNAT, benchmark, documentation, multicast, IPv6 non-global incl. IPv4-mapped,
NAT64, 6to4-wrapped private, Teredo), DoH A+AAAA pre-resolution with refusal if ANY answer is non-public, manual redirects
(max 3, every hop re-validated, loop detection, optional same-origin pin for the IndexNow key file), one AbortController
deadline over DNS and all hops, streaming body read with a byte cap that also aborts a stalled body, fixed User-Agent.

Platform (measured above): Workers' outbound fetch refuses private literals (1003) and a hostname resolving to loopback (1016/530).

Residual: Workers do not let us pin the connection to the address we validated, so a hostile DNS server could answer our
DoH query with a public address and the runtime's own lookup with a private one (DNS rebinding, TTL 0). The platform
refusal above covers the private ranges we tested; I have not tested every range (for example CGNAT or IPv6 ULA) through a
rebinding name, and could not find documentation listing exactly what the platform blocks. Node keeps true address pinning.

## 7. Known differences and risks

- **Auditing a site on the same Cloudflare zone (tatinc.us) sees a different robots.txt than the public.** The zone's
  "managed robots.txt" (which blocks GPTBot/ClaudeBot/Google-Extended for everyone else) is not applied to the Worker's
  same-zone subrequest, so the Worker's audit of dispatch.tatinc.us reports those bots as "unspecified" while a local run
  reports them blocked. Third-party sites are unaffected. Documented in BLOCKERS.
- **IndexNow from Cloudflare egress:** both real pings (two different URLs) got 429, while the same key/host got 202 from
  the Mac earlier tonight. Likely (not proven) that api.indexnow.org rate-limits Cloudflare's shared egress IPs; the
  alternative is a per-host limit after tonight's earlier ping. One more ping after a few hours would tell; see BLOCKERS 0.
  Because of this the public page was NOT switched to the Worker (the run's rule: switch only if every smoke test passed).
- **Brave may change its view of Cloudflare's browser** (it is visibly HeadlessChrome from a Cloudflare IP). If Brave starts
  challenging it, the tool reports `verification_required`; we never solve or evade checks. Fallback: Node/Docker host.
- **Workers Free CPU (10 ms)** would likely break the Brave path (239 ms measured) if the account were ever moved to Free.
- `snapshot-cloudflare-baseline` is not on the Worker (self-host only, as before).
- The spike left a `SPIKE_TOKEN` secret on the `dispatch-mcp` Worker. The deployed code never reads it. Remove with
  `cd deploy/mcp && npx wrangler secret delete SPIKE_TOKEN` (left in place: tonight's rules allowed no deletes).

## 8. Fallbacks for the Brave path (if Browser Run stops working)

Keep the Worker for audit-site, submit-indexnow and the canvas, and run `submit-brave-url` on a Node host with the
existing Dockerfile, pointing the canvas/clients at that host for Brave only. Options (not signed up for, numbers not
re-verified tonight unless stated): Manufact (current host, paused for usage; resumes when the budget allows); any
Docker host (the image needs ~1 GB RAM for Chromium, measured on Manufact: 1 CPU / 962 MB worked, 16 s cold launch);
Oracle Cloud Always Free, Google Cloud Run, Hugging Face Spaces (free tiers exist; I did not verify their current limits
or terms tonight, so check before relying on them).

## 9. What changed (files)

New: `src/safe-fetch-core.ts`, `src/submit-core.ts`, `src/tool-defs.ts`, `src/limits.ts`, `src/worker/{index,limiter-do,brave-browser-run,safe-fetch-worker,safe-fetch-default}.ts`,
`deploy/mcp/{wrangler.jsonc,tsconfig.json,worker-configuration.d.ts,stub-mcp-use-client.js}`, `scripts/build-worker.mjs`,
`scripts/spikes/browser-run-spike-2026-10-29.ts` (record only), `test/{limits,safe-fetch-worker}.test.ts`.
Changed: `src/safe-fetch.ts` (now the Node adapter over the core), `src/submit.ts` (Node wrapper over the core, reports `browserMs`),
`src/audit.ts`, `src/indexnow.ts` (import `#safe-fetch`; no `node:net`/`Buffer`), `index.ts` (uses shared tool defs), `package.json`
(`imports`, `@cloudflare/puppeteer`, `build:worker`, `typecheck:worker`, `deploy:worker`), `tsconfig.json`, `scripts/mcp-call.mjs` (`resources`, `read`).

Commands: `npm run typecheck` · `npm run typecheck:worker` · `npm test` · `npm run deploy:worker`
(= `node scripts/build-worker.mjs && cd deploy/mcp && npx wrangler@latest deploy`, with `CLOUDFLARE_ACCOUNT_ID` set).

## 10. Rollback

- The page: rebuild with the old URL and redeploy the page Worker:
  `node scripts/build-site.mjs && cd deploy/site && CLOUDFLARE_ACCOUNT_ID=<id> npx wrangler@latest deploy`
  (the build script's default MCP_URL is still the Manufact warm-wave URL).
- The Worker: `cd deploy/mcp && npx wrangler rollback` to a previous version, or remove the custom domain / delete the
  `dispatch-mcp` Worker in the dashboard (Workers & Pages > dispatch-mcp > Settings). Nothing else on the account depends on it.
- The code: `feat/cf-port` is local only; `feat/go-live` is untouched.
