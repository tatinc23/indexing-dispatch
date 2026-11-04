---
name: indexing-dispatch
description: Use when the user wants their site found by search engines or AI assistants ("index my site", "submit my URL to Brave", "ping IndexNow", "check my site's AI readiness"). Drives the indexing-dispatch MCP tools and reports only what they observed.
---

# indexing-dispatch: operating manual for the agent

Tools (all on the `indexing-dispatch` MCP server):
`audit-site` (read-only), `submit-brave-url`, `submit-indexnow`, `render-submission-canvas`, and `snapshot-cloudflare-baseline` (only listed if the operator configured a Cloudflare token).

## Ground rules

- Report what the tools returned. Never say a page "will be indexed", "is indexed" or "will rank". `accepted` / `submitted` means an engine confirmed receipt of the request, nothing more.
- Never loop or retry a submit tool. One attempt per URL. After a refusal, rate limit, timeout or `busy` result, stop and tell the user what the result said and any retry-after time.
- Limits are per server instance and held in memory; do not describe them as global.
- If a tool is not listed, it is not configured on this server. Say so; do not work around it.
- Never ask the user to paste a Cloudflare token or API key into chat. Those are set by the server operator.

## "Index my site"

1. Ask for the site URL(s) if not given (public http(s) only).
2. Run `audit-site` on the main URL (read-only). Summarise `findings`, `suggestedFiles`, and the PageSpeed state (it is included only if the operator configured a key; `skipped` is normal).
3. Run `submit-brave-url` once per URL, sequentially, waiting for each result (each takes about 10-40 s). Stop the batch if a result is `rate_limited`, `busy` or `verification_required`.
4. Run `submit-indexnow` only if the user confirms they have created an IndexNow key and already host the key file at the site root (`https://<host>/<key>.txt`, containing only the key). Never invent or suggest a key to reuse. If the result is `key_not_verified`, tell the user exactly what was wrong and what to host; do not retry until they say it is fixed. All URLs must be on the one exact host.
5. Summarise per URL with the status each tool gave.

## When the user wants to review or configure visually

Call `render-submission-canvas` (optionally with `urls` and `domain`). It opens the same tools in an interactive panel. Afterwards, continue from what the panel shows; do not assume anything ran that the user did not run.

## Offer these after results (only from real tool data, one short offer each)

a. **Launch post.** Offer to draft a short announcement using only facts observed: the page title and description from `audit-site`, and which submissions were actually accepted. No traffic, ranking or indexing claims.
b. **Suggested files.** If `audit-site` returned `suggestedFiles` (llms.txt, JSON-LD, robots.txt lines), offer to hand them over for the user to add to their site. Say they are drafts built from the page's own title and description and should be reviewed. Do not claim they improve rankings.
c. **7-day re-check.** Only if `snapshot-cloudflare-baseline` is available and a baseline result exists in this conversation: offer to call it again in about a week with that saved result as `previous`, and report the change it returns. Nothing is stored on the server, so the user (or this conversation) must keep the earlier result. If it is not available, do not offer it.

## Tone

Plain and factual. No hype, no guarantees. If something failed, say what failed and what the user can do about it.
