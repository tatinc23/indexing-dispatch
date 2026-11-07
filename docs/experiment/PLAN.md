# Experiment: does telling search engines help? (started 2026-10-30)

We don't know. Indexing Dispatch is brand new, and nobody can promise that pinging Brave or IndexNow gets a page seen sooner or at all. So we measure our own domain, run the tools for real once, measure again in a week, and publish what happened, flat results included. People can follow along or run it on their own site.

## Status
- [x] **Baseline taken 2026-10-31** (`docs/experiment/snapshot-baseline-2026-10-31.json`, window 2026-10-24 to 2026-10-31, after the maintainer added Zone Analytics Read to the existing Cloudflare token). Earlier attempts failed with a permission error; nothing was invented. Note: `dispatch.tatinc.us` already shows some Claude crawler requests (ClaudeBot 17, Claude-SearchBot 14) before any real ping, likely from our own deploys, tests and the leaderboard scan, so the before/after must be read with that in mind.
- [x] Visibility datapoint, 2026-10-30: a `site:dispatch.tatinc.us` search through this assistant's search tool returned no pages from the domain. That tool is not Brave or Bing, so this is a weak datapoint, not the baseline. The real before/after check is a manual `site:` search in Brave and Bing by the maintainer on the same days.
- [x] Real run 2026-10-31 (`docs/experiment/run-log-2026-10-31.md`): audits of dispatch and tatinc.us; Brave ACCEPTED for dispatch.tatinc.us, tatinc.us, chatterbox.tatinc.us (10:23-10:24Z); one IndexNow POST (HTTP 200, URLs received) at 10:42Z. Control shabba.tatinc.us not submitted.
- [ ] Re-measure on **2026-11-06** (7 days later) and compare
- [ ] Post results (drafts: `docs/experiment/social-drafts.md`)

## Measure (read-only, same script both times)
```
CF_ANALYTICS_API_TOKEN=<scoped read token> CF_ZONE_ID=<32-hex zone id> \
  node --import tsx scripts/experiment-baseline.ts baseline-YYYY-MM-DD 7
```
Writes `docs/experiment/snapshot-<label>.json` (no token, no zone id). It records, for the last 7 days: zone requests/bytes (Cloudflare daily totals), and per host (`dispatch.tatinc.us`, `dispatch-mcp.tatinc.us`, `tatinc.us`, and the control `shabba.tatinc.us`) eyeball requests, visits, and requests whose user-agent names an AI crawler (GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-User, Claude-SearchBot, PerplexityBot, Perplexity-User). Caveats are in the file: sampled data, spoofable user-agents; Brave's crawler and Google-Extended have no user-agent token and can't be counted this way.

## Run for real (once each, never looped; TAT-owned URLs only)
Use the live server, not a mock, and save every exact reply in `docs/experiment/run-log-2026-MM-DD.md`.
1. `audit-site` on `https://dispatch.tatinc.us/` and `https://tatinc.us/` (read-only).
2. `submit-brave-url` for `https://dispatch.tatinc.us/`, `https://tatinc.us/`, `https://chatterbox.tatinc.us/`. Brave limits: 12 an hour, same URL not resent within 24 h.
3. `submit-indexnow` for `dispatch.tatinc.us` only (the only host with a key file). The Worker's egress got HTTP 429 twice, so send it from the Mac: `node --import tsx scripts/live-indexnow.ts dispatch.tatinc.us <id> https://dispatch.tatinc.us/` (the key is public by design; it is the key file at the site root). the maintainer confirms the URL list before the run.
4. Control: `shabba.tatinc.us` is NOT submitted. It shows what happens to a similar TAT page with no ping.

## Read the result honestly
- One domain, one week, tiny numbers, no randomisation. A social post will also bring human visits and some crawlers, which confounds everything. The control host helps a little, not a lot.
- "Accepted" or "submitted" only means the other side received the request. We report that, and separately whether the page shows up in a `site:` search.
- If nothing changes, we say so.
