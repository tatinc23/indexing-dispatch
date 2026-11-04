# Discovery suite (design, 2026-10-27)

Goal: grow indexing-dispatch from one tool into "AI Discovery, Indexing & Audit Suite" without ever returning a fabricated result.
Source vision: the maintainer's Gemini/Argon prompt (kept out of git in `Gemini 4 Argon/`). Argon's code is a UI mock with simulated tools; we reuse its layout and concepts only.

## Tools (all behind the existing access gate; kebab-case)
| Tool | Kind | Notes |
|---|---|---|
| `submit-brave-url` | existing, unchanged | real headless submission |
| `submit-indexnow` | write, openWorld | fetch `keyLocation` first and require the body to equal the key; only then ping the IndexNow endpoint(s). No default key. Max 100 URLs, all on `host`. |
| `audit-site` | readOnly, openWorld | SSRF-safe fetch of the page, /llms.txt, /robots.txt, sitemap; parse JSON-LD/OG; optional Google PageSpeed Insights if `PAGESPEED_API_KEY` set (else `pageSpeed.status="skipped"`); deterministic findings + drafted `suggestedFiles` |
| `snapshot-cloudflare-baseline` | readOnly, openWorld | registered ONLY when `CF_ANALYTICS_API_TOKEN` env is set; accepts optional `previous` and returns delta (stateless re-check) |
| `render-submission-canvas` | widget | interactive UI; calls the other tools for real |

Result shapes: `src/contract.ts` (authoritative).

## Rules
- No simulation, no hash-seeded numbers, no hardcoded keys/zone ids, no "simulate failures" params, no fallback that fabricates success. Errors are reported as errors.
- Chromium sandbox stays ON (never `--no-sandbox` by default).
- Any fetch of a caller-supplied URL goes through `src/safe-fetch.ts` (SSRF guard).
- Proactive hooks (social draft, llms.txt/schema patch, 7-day re-check) are agent behaviour documented in `SKILL.md` plus real `findings`/`suggestedFiles` data; the server never schedules anything.
- Tone for all user-facing strings: plain, matter-of-fact (the maintainer's note); no hype.
- Terms: read each engine's current terms before building against it; record in `docs/COMPLIANCE.md`.
