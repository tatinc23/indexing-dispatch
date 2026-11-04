# Indexing Dispatch

Indexing Dispatch by TAT Inc. Not affiliated with, endorsed by or sponsored by Brave Software. "Brave" is a trademark of Brave Software, Inc. and is used here only to describe what the tools submit to.

A remote MCP server (mcp-use) that helps a site owner get found by search engines and AI assistants, and reports what actually happened. It never returns an estimated or simulated result: every value comes from a response the server received.

"Accepted" and "submitted" mean an engine confirmed it received the request. They are not a promise that a page will be indexed or ranked.

Does telling search engines help? We don't know. It is free, and we are measuring our own domain for a week and publishing the result either way: `docs/experiment/PLAN.md`.

## Tools

| Tool | What it does | Input |
|---|---|---|
| `submit-brave-url` | Submits one URL to https://search.brave.com/submit-url in a real headless Chromium and reports what Brave's page showed. | `targetUrl` |
| `submit-indexnow` | Checks that your IndexNow key file is live on your host, then sends one IndexNow request for up to 100 URLs. | `host`, `key`, `urls`, optional `keyLocation` |
| `audit-site` | Read-only check of one page: title, description, canonical, language, JSON-LD, Open Graph, plus the site's robots.txt rules for AI and search crawlers, llms.txt and sitemap. Drafts llms.txt, JSON-LD and robots.txt lines from facts found on the page. | `targetUrl`, optional `strategy` (`mobile` or `desktop`, PageSpeed only) |
| `render-submission-canvas` | Opens an interactive panel (an MCP App view) that runs the other tools for real. | optional `urls`, `domain`, `mode` |
| `snapshot-cloudflare-baseline` | Reads request, byte and AI-crawler counts for a Cloudflare zone the operator listed. Only offered when the operator configured it (see below). | `zoneId`, optional `lookbackDays`, optional `previous` |

Result shapes are defined in `src/contract.ts` (discovery tools) and `src/schema.ts` (Brave). Non-success results set `isError`.

### submit-brave-url
`targetUrl`: absolute http(s) URL, max 2048 chars, no `user:pass@`, public host only (localhost, `*.local` and private or link-local IPs are refused).

| field | meaning |
|---|---|
| `status` | `accepted` · `rejected` · `verification_required` · `timeout` · `error` |
| `message` | plain-words explanation |
| `confirmationText` | Brave's confirmation text (accepted only) |
| `errorCode` | for `error`: `busy`, `rate_limited`, `recently_submitted`, `browser_launch_failed`, `navigation_failed`, `http_error`, `unexpected_navigation`, `input_not_found`, `input_mismatch`, `submit_button_not_found`, `submit_button_disabled`, `unexpected_error` |
| `retryAfterSeconds` | for local-limit errors |
| `durationMs` | wall clock |
| `diagnostics` | non-accepted only: final URL (no query), de-duplicated state timeline, sanitized text excerpt; a JPEG screenshot is attached as an image block |

How the status is decided: after clicking **Submit** the page is polled. No verdict is issued in the first 2 s. `accepted` needs the exact text "Thank you for your submission." and either a "Success" label in the same region or a `Submitted` button. A human challenge is reported only if it stays visible for 6 s; the passive "Verifying you're a human being" text Brave shows for about 4 s is ignored. If nothing definitive appears within 30 s the result is `timeout` (the URL may or may not have been received). Rejection detection is fixture-tested only: no real Brave rejection has been observed, so the selectors are unverified against one.

### submit-indexnow
- `host`: the exact host the URLs belong to, e.g. `www.example.com`. Subdomains are separate hosts.
- `key`: your IndexNow key, 8 to 128 characters, letters, digits and hyphens. You create it; no key is built in.
- `urls`: up to 100 per call, all http(s), all on `host`, and under the key file's folder.
- `keyLocation`: only if the key file is not at `https://<host>/<key>.txt`. Must be on the same host.

You host the key file yourself at `https://<host>/<key>.txt`, as plain text containing only the key. The tool fetches that file first (through the SSRF-guarded fetch) and sends nothing unless it matches exactly. Then it makes one POST to `https://api.indexnow.org/indexnow`. IndexNow shares one submission with every participating engine, so there is no per-engine fan-out. The request is attempted once and never retried.

| `status` | meaning |
|---|---|
| `submitted` | IndexNow answered HTTP 200 or 202. It received the request. |
| `key_not_verified` | The key file could not be fetched, answered an error, or did not contain exactly the key. Nothing was sent. |
| `rejected` | IndexNow answered 4xx (for example 403 key not valid for the host, 422, 429). The message says which. |
| `blocked` | The key file address was refused by the SSRF guard. Nothing was sent. |
| `error` | Bad input, a local limit, or a network failure. If the request itself failed, whether IndexNow received it is unknown. |

### audit-site
Reports only what it fetched: the page, `/llms.txt`, `/robots.txt` and a sitemap (from `Sitemap:` lines in robots.txt, else `/sitemap.xml`), all from the page's final origin. `status` is `ok`, `unreachable`, `blocked` (refused by the SSRF guard) or `error`. Output includes `page`, `aiReadiness` (llms.txt, per-crawler robots.txt rule for `/`, sitemap), `pageSpeed`, deterministic `findings`, and `suggestedFiles`.

- robots.txt rules are checked for GPTBot, OAI-SearchBot, ClaudeBot, PerplexityBot, Google-Extended, Googlebot and Bingbot, evaluated for the path `/` only. Brave publishes no crawler token, so no Brave rule is reported.
- `suggestedFiles` are drafts built from the page's own title, description, URL and same-origin links. Review them before use. robots.txt Allow lines are suggested only for search and answer crawlers (OAI-SearchBot, PerplexityBot); allowing training crawlers is your policy call, so they are reported but never suggested.
- Page title, description, canonical and language have HTML entities decoded (`&mdash;`, `&#8212;`, `&amp;` and similar).
- PageSpeed is optional and off unless the server operator sets `PAGESPEED_API_KEY`. Without it, `pageSpeed.status` is `skipped`. With it, the server calls Google's PageSpeed Insights API once per audit, returns scores for the requested URL only, and stores nothing. It is subject to the [Google APIs Terms](https://developers.google.com/terms), and every caller spends the operator's key quota. The public hosted instance does not set a key.

### render-submission-canvas
Opens a panel in MCP-Apps-capable hosts. The panel calls `submit-brave-url`, `submit-indexnow`, `audit-site` and (if offered) `snapshot-cloudflare-baseline` through the host and shows their real results. Source: `views/render-submission-canvas/`; a local test harness with a mock runner is in `harness/canvas/`. The widget has been run in that local harness only. It has not been tested in a real Claude or ChatGPT host.

### snapshot-cloudflare-baseline (self-host only)
Registered only when the operator sets both `CF_ANALYTICS_API_TOKEN` and `CF_ZONE_IDS`. The token lives in the server's environment and is never a tool argument; it is redacted from error messages. A token can usually read every zone on its account, so callers may only query zones listed in `CF_ZONE_IDS` (comma or space separated, 32-hex zone ids). Any other zone id is refused before a Cloudflare call is made.

It returns request and byte totals for the window (1 to 30 days, default 7), unique visitors only for a one-day window (daily uniques overlap and cannot be added), and request counts for AI crawlers matched by user-agent string. Crawler counts come from Cloudflare's sampled data and anyone can spoof a user-agent, so treat them as estimates. A failed sub-query is reported as failed, not filled in.

The 7-day re-check is stateless: nothing is stored on the server. Keep the earlier result and pass it back as `previous` a week later; the tool returns the change. Use a read-only token (Zone > Analytics > Read).

Status: the GraphQL queries are checked against Cloudflare's schema and unit-tested with mocked responses. They have not been run against a real zone.

## Access (public access is an explicit choice; the hosted instance is public)
`tools/call` is refused unless the operator sets one of:
- `BRAVE_SUBMITTER_API_KEY`: clients must send `Authorization: Bearer <key>` (works with Claude Code, Cursor and SDK clients; not with claude.ai web connectors, which only speak OAuth), or
- `BRAVE_SUBMITTER_ALLOW_PUBLIC=true`: anyone reaching the endpoint can call the tools.

`tools/list` stays open so clients can discover the tools. OAuth providers exist in mcp-use but all need an external identity provider.

## Limits (Node/Docker: per server process, in memory; NOT global or distributed)
On the Cloudflare Workers deployment the same budgets are global (one Durable Object; see Hosting). On Node, a restart or a second instance resets these counters. Manufact's gateway can add per-caller rate limiting and IP allowlists on top. No per-caller limit is set today, so one caller can use up a shared budget.

| Tool | Concurrent | Per hour | Repeat protection |
|---|---|---|---|
| `submit-brave-url` | 1 (`BRAVE_SUBMITTER_MAX_CONCURRENT`, 1 to 3) | 12 (`BRAVE_SUBMITTER_MAX_PER_HOUR`, 1 to 60) | a URL that reached Brave is not re-sent for 24 h (`BRAVE_SUBMITTER_DEDUPE_HOURS`, 1 to 168) |
| `submit-indexnow` | 1 | 6 | the same host and URL set is not re-sent for 1 h |
| `audit-site` | 3 | 40 | none (it only reads) |
| `snapshot-cloudflare-baseline` | 2 | 20 | none |

Time budgets: `submit-brave-url` 80 s for the whole call (Manufact's container has 1 CPU and about 960 MB; a cold Chromium launch measured 16 s); a new browser with a fresh profile per call, always closed in `finally`. Fetches in the audit and IndexNow key check time out at 8 s each; the IndexNow POST at 10 s; PageSpeed at 25 s.

## Environment variables
Names only; see `.env.example`. Set these as environment variables on your own host.

| Variable | Purpose |
|---|---|
| `BRAVE_SUBMITTER_API_KEY` | Require `Authorization: Bearer <key>` on `tools/call`. |
| `BRAVE_SUBMITTER_ALLOW_PUBLIC` | `true` for public mode. One of this or the API key is required. |
| `BRAVE_SUBMITTER_MAX_CONCURRENT`, `..._MAX_PER_HOUR`, `..._DEDUPE_HOURS` | Brave limits (above). |
| `BRAVE_SUBMITTER_NO_SANDBOX` | `1` adds Chromium `--no-sandbox`. Explicit opt-in only; see Browser and sandbox. |
| `BRAVE_SUBMITTER_SELFCHECK` | `0` skips the boot-time Chromium launch check. |
| `PAGESPEED_API_KEY` | Enables the PageSpeed section of `audit-site`. Unset means `skipped`. |
| `CF_ANALYTICS_API_TOKEN` | Read-only Cloudflare analytics token. With `CF_ZONE_IDS`, enables `snapshot-cloudflare-baseline`. |
| `CF_ZONE_IDS` | Comma or space separated 32-hex zone ids callers may query. |

## SSRF protections (audit-site and the IndexNow key check)
Any fetch of a caller-supplied URL goes through the SSRF guard: `src/safe-fetch.ts` on Node, `src/worker/safe-fetch-worker.ts` on Cloudflare Workers (shared rules in `src/safe-fetch-core.ts`; on Workers DNS is checked over DNS-over-HTTPS, only ports 80/443 are allowed, and the connection cannot be pinned to the checked address, so the residual DNS-rebinding window is covered by Cloudflare refusing private addresses; see `docs/cloudflare-port-plan.md` section 6):
- Only `http` and `https`; URLs with embedded credentials and `localhost` names are refused.
- DNS is resolved by the server and every returned address must be public. Refused: loopback, private (10/8, 172.16/12, 192.168/16), link-local and cloud-metadata (169.254/16), carrier-grade NAT, documentation and benchmark ranges, multicast and reserved space, and for IPv6 anything that is not global unicast (plus IPv4-mapped, NAT64, 6to4 wrapping a non-public IPv4, Teredo).
- The socket connects to the exact address that was validated, so a second DNS answer cannot redirect it. Host header and TLS server name still use the hostname.
- Redirects are followed by hand, at most 3, and every hop is re-checked. audit-site pins llms.txt, robots.txt and sitemap fetches to the page's own origin; the IndexNow key fetch is pinned to the key file's origin.
- Bodies are capped (1 MB by default, 16 MB at most), timeouts are enforced across all hops, and no cookies or connection reuse are used. The user agent is `indexing-dispatch-audit/1.0` with the repo URL.
- HTML and robots.txt parsing is bounded and linear-time, so a hostile page cannot cost more than a fixed multiple of its (capped) size.

## Browser and sandbox
Chromium runs with its sandbox on. `BRAVE_SUBMITTER_NO_SANDBOX=1` adds `--no-sandbox` and is only for container hosts that forbid user namespaces; it removes the renderer sandbox, so the only protection left is container isolation and the fact that the browser only ever visits Brave's page (navigation off `search.brave.com` aborts the run). It is never set by default. On boot the server launches Chromium once and logs `browser-selfcheck` (version, sandbox mode, memory and CPU); check the runtime logs after deploy.

## Hosted instance (Cloudflare Workers, public, no auth)
- **Endpoint:** `https://dispatch-mcp.tatinc.us/mcp` (streamable HTTP; Worker `dispatch-mcp`), run by TAT Inc. Anyone can call `tools/call`; Brave's own submit page also lets anyone submit any URL without signing in. Best effort, no SLA; it may be rate limited or taken down at any time. Page and setup help: https://dispatch.tatinc.us.
- **Tools:** `submit-brave-url`, `submit-indexnow`, `audit-site`, `render-submission-canvas`. `snapshot-cloudflare-baseline` is not offered on the hosted instance (it needs an operator's own token and zone list). PageSpeed is off there (no key).
- **How it runs:** `submit-brave-url` uses Cloudflare Browser Run (`@cloudflare/puppeteer`); the SSRF guard checks DNS over HTTPS (`src/worker/safe-fetch-worker.ts`); all limits are **global** (one Durable Object), including a daily browser-time budget of 8 minutes (below Browser Run's 10 free minutes per day). Facts, limits math, risks and rollback: `docs/cloudflare-port-plan.md`.
- **IndexNow from the hosted instance:** two test pings from Cloudflare's network were answered with HTTP 429 (2026-10-29). If you hit that, send IndexNow from your own machine (`scripts/live-indexnow.ts`) or self-host.
- **Plan note:** the Brave flow measured about 240 ms CPU per call, above the Workers Free limit of 10 ms per request, so run your own copy on a Workers Paid account.
- **What is logged:** one JSON line per call with the target's origin and path (no query string) or host, status, error code and duration; no caller identity or request headers.
- **Client config:**
  ```bash
  claude mcp add --transport http indexing-dispatch https://dispatch-mcp.tatinc.us/mcp
  ```
  ```json
  { "mcpServers": { "indexing-dispatch": { "type": "http", "url": "https://dispatch-mcp.tatinc.us/mcp" } } }
  ```
  Step-by-step setup for Claude, Codex, Cursor and ChatGPT: `docs/connect-steps.md`.
- **Deploy your own:** `CLOUDFLARE_ACCOUNT_ID=<your account id> npm run deploy:worker` (builds the inline canvas with `scripts/build-worker.mjs`, then `wrangler deploy` from `deploy/mcp/`). Type-check with `npm run typecheck:worker`.
- **Node build:** the same tools also run as a plain Node server (see Self-hosting); on Node the limits are per process.

## For agents
`SKILL.md` is the operating manual for an AI agent using these tools: ground rules (report only what a tool returned, one attempt per URL, never loop a submit tool), the "index my site" sequence, and short offers to make after results.

## Self-hosting
Node >= 22.22.2 with Chromium. A `Dockerfile` is included (Debian Chromium, non-root, sandbox on), or deploy to Manufact Cloud with `npm run deploy`. Set either `BRAVE_SUBMITTER_API_KEY` or `BRAVE_SUBMITTER_ALLOW_PUBLIC=true`; with neither, `tools/call` is refused. The Dockerfile has only been built by Manufact's pipeline, not by the maintainers locally.

## Terms
- Brave: this tool automates Brave's public submit-URL form on your behalf. You are responsible for submitting only URLs you have the right to submit and for following [Brave's terms](https://brave.com/terms-of-use/). It does not solve CAPTCHAs or evade bot checks; it reports `verification_required` instead.
- IndexNow: you must host your own key file for each host. The protocol and its terms are at https://www.indexnow.org/.
- PageSpeed and Cloudflare: only if you configure them, under Google's and Cloudflare's own terms and your own keys.
- Review notes for every party: `docs/COMPLIANCE.md`. Engine and API facts: `docs/engines-2026-10-27.md`.

## Develop
```bash
npm install
npm run typecheck && npm test    # unit tests + real-Chromium fixture tests; never contacts Brave
npm run build
BRAVE_SUBMITTER_API_KEY=dev-key PORT=3111 npm start
MCP_BEARER=dev-key node scripts/mcp-call.mjs http://localhost:3111/mcp list
```
`scripts/inspect-dom.mjs` (read-only look at Brave's page) and `scripts/live-submit.ts <url>` (REAL submission) are manual tools. Do not run `live-submit` repeatedly for the same URL.

## License
MIT. See `LICENSE`.
