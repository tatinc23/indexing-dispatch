# Compliance record: parties and terms (checked 2026-10-25)

Per the TAT rule "stay within the terms": every party involved, what their current published terms say,
and the design decision that follows. Re-check before changing behaviour.

## Brave Search (the target)
- **Page:** https://search.brave.com/submit-url — "Insert the URL to be re-fetched", one URL input, one Submit button.
  Read live on 2026-10-25 (input `#url`, `autocomplete=url`; button `name="captcha-button"`).
- **Terms:** Brave's general Terms of Use (https://brave.com/terms-of-use/, "LAST UPDATED May 11, 2023").
  - No clause about bots, scraping, or automated submission.
  - "Rules and Conduct" forbids actions that "impose or may impose an unreasonable or disproportionately large load" on
    Brave's infrastructure and forbids "bypass[ing] any measures Brave may use to prevent or restrict access to the Service".
  - "Brave may also impose limits on certain features and services."
  - Not stated whether Brave Search is covered by these terms. The Search API has separate terms; this project does not use the API.
  - **No published Brave policy on automating submit-url was found** (web search, 2026-10-25). Community posts only say the page exists.
- **Observed behaviour:** a plain HTTP fetch of the page got HTTP 429 (Brave rate-limits clients). In a normal browser the page runs a
  passive "Verifying you're a human being" step (about 4 s), then accepts the click. This project waits for that normal flow.
- **Design consequences:**
  - No CAPTCHA solving, stealth plugins, fingerprint spoofing, proxy rotation, or challenge-solving services. If a human challenge
    persists, the tool returns `verification_required`.
  - One URL per call, no bulk mode, no automatic retries, one browser at a time, default 12 submissions/hour/instance,
    a URL that reached Brave is not re-sent for 24 h (per instance).
  - The destination is a constant; client input cannot change it.

## Manufact (hosting)
- Dockerfile builds are used "as-is" (docs.manufact.com/dashboard/build-runtimes). Docs do **not** state: system packages, browser/Chromium
  support, CPU/memory/timeouts, sandboxing, or auth defaults. Browser support is therefore verified empirically (boot-time self-check in runtime logs).
- Deploying from personal/GitHub-org repos is included on all plans including Free (docs.manufact.com/dashboard/servers). Quotas are not published there.

## Puppeteer / Chromium
- Debian `chromium` package installed in the image; Puppeteer's bundled download is skipped. Licenses: Puppeteer Apache-2.0, Chromium BSD-style.

## Public operation (maintainer decision, 2026-10-25)
- Endpoint is public. The maintainer accepted the residual risk that Brave may not approve of automated submissions on behalf of third parties and that
  Brave could throttle/block the Manufact egress IP; the plan is to take it down if Brave or anyone objects. No contact with Brave has been made.
- Brave's own submit page has no sign-in, so any URL can already be submitted by anyone; this tool adds no capability Brave does not offer.
- Directory listings are NOT yet submitted; each directory's current terms must be read and recorded here before submitting.

## Directory terms (read 2026-10-27)
- **Claude Connectors Directory** (https://claude.com/docs/connectors/building/submission): remote HTTPS server, tool `title` + `readOnlyHint`/`destructiveHint`, privacy policy URL, docs URL, support contact, reviewer test instructions, seven policy acknowledgements incl. "first-party API usage". No-auth is allowed for public data.
  **Blocker:** Anthropic Software Directory Policy §3F: "Developers must verify that they own or control any API endpoint, domain, or user interface their Software connects to." This tool drives Brave's submit form, which TAT does not own. Do not submit unless Brave grants permission in writing.
- **ChatGPT app directory** (https://developers.openai.com/plugins/deploy/app-review): public domain, company + privacy policy URLs, identity verification, tool annotations (incl. `openWorldHint`), test cases. That page says nothing on third-party automation; OpenAI's announcement page (reported to require adherence to third-party terms) returned 403 and was NOT read. Unresolved.

## Discovery suite terms (read 2026-10-27)
Facts and sources: `docs/engines-2026-10-27.md`. "Not found" = looked, official source silent.

- **IndexNow protocol** (https://www.indexnow.org/documentation, /faq, /terms). Ownership gate is the key file: "To submit URLs, you must 'prove' ownership of the host for which URLs are being submitted by hosting at least one text file within the host."
  - **Terms of Service** (https://www.indexnow.org/terms; contract with Yandex N.V., Seznam.cz, a.s., Microsoft Corporation) cover the indexnow.org website; the specification is CC BY-SA 4.0. They say nothing about who may send submissions, relays, or automation. They reserve changes to the protocol and say no sponsor is "obligated to index, read or otherwise make use of" submissions.
  - **Third-party submission:** no page says a third party may or may not submit for a host. Only the key-file-on-host check is stated. Not found: any explicit relay clause.
  - **Sharing:** "your submission will be shared across all IndexNow-enabled search engines" and "You may submit your request to only one of the following participating endpoints." Design: ping ONE endpoint (`https://api.indexnow.org/indexnow`), do not fan out.
  - **Rate/abuse:** "IndexNow does not publicly disclose exact rate limits, as each participating search engine sets its own daily submission thresholds per site." 429 = "Too Many Requests (potential Spam)"; honour `Retry-After`; "Wait at least 10 minutes before resubmitting the same URL, unless it has changed significantly." "Submit only when content has changed. Do not resubmit unchanged URLs." Max 10,000 URLs per POST (suite cap 100).
  - **Design consequences:** require the key file on the submitted host (we fetch it first and compare); no default/shared key; never log or echo keys; 10-minute per-(host,URL) de-dupe; no automatic retries; no "submit the whole site" mode.
- **Bing Webmaster / Bing (IndexNow participant).** Microsoft's Bing Webmaster API page (https://learn.microsoft.com/en-us/bingwebmaster/) lists "Microsoft Service Agreement: Terms and conditions regarding usage of Bing Webmaster API". A Microsoft Q&A answer says no separate Webmaster Tools terms document exists (community answer, not official). The Microsoft Services Agreement is consumer-oriented and I did not read it clause by clause: not found: any clause specific to automated third-party IndexNow submission. This tool does NOT use the Bing Webmaster API (no Bing account, no API key); it only sends IndexNow pings.
- **Yandex.** IndexNow reference (https://www.yandex.com/support/webmaster/en/indexnow/reference.md): "There is no limit on the number of requests. You can adjust their frequency: Yandex uses algorithms that prevent sending too many requests." and "We don't recommend sending the same URL too often. If needed, send it at 10-minute intervals." 429 = "The number of requests for one IP address is exceeded." Key page: "Yandex checks the key in every API request." Not found: Yandex Webmaster user agreement text and any relay/third-party clause. Consequence: a public relay shares one egress IP across all callers, so the per-IP 429 is a real risk; keep the per-instance limits.
- **Naver Search Advisor.** Participates in IndexNow (`https://searchadvisor.naver.com/indexnow`, listed in the IndexNow FAQ). Naver's terms of service and any Naver-specific rule on automated submission: NOT FOUND (page not readable as text; /indexnow redirects to indexnow.org). We do not call Naver directly: the single ping to api.indexnow.org is what the FAQ says is shared onward.
- **Google PageSpeed Insights API.** Docs: "The API can be used with or without an API key, although a key is recommended for frequent, automated queries." LIVE 2026-10-27: keyless calls returned 429 "Quota exceeded for quota metric 'Queries' and limit 'Queries per day'" with `quota_limit_value: "0"` on a shared Google project. So a key is effectively required. Governing terms: Google APIs Terms of Service (https://developers.google.com/terms, "Last modified: November 9, 2021"). Clauses that touch a public relay:
  - 2.c: "You will only access (or attempt to access) an API by the means described in the documentation of that API." and "You will not misrepresent or mask either your identity or your API Client's identity when using the APIs".
  - 2.d: "Google sets and enforces limits on your use of the APIs ... You agree to, and will not attempt to circumvent, such limitations". Every public caller spends the operator's one key quota; do not rotate keys or add projects to get around limits.
  - 4.b: "You will keep your credentials confidential and make reasonable efforts to prevent and discourage other API Clients from using your credentials. Developer credentials may not be embedded in open source projects." Key lives only in the `PAGESPEED_API_KEY` env var, never in the repo or in any tool result.
  - 5.e: with "content returned from the APIs" you will not "Scrape, build databases, or otherwise create permanent copies of such content, or keep cached copies longer than permitted by the cache header" and not "Copy, translate, modify, create a derivative work of, sell, lease, lend, convey, distribute, publicly display, or sublicense to any third party". Whether a numeric score returned to the person who asked for that page's audit is "distribute ... to any third party" is NOT settled by the text. Conservative reading: run per request, return only the metrics for the requested URL, store nothing, no cache, no dataset. the maintainer's call if the relay is later opened wider.
  - 4.a (API Prohibitions) was not analysed in detail.
  - Design consequences: PSI only when `PAGESPEED_API_KEY` is set, otherwise `pageSpeed.status = "skipped"`; no response caching; one run per audit call; report Google's 429 as an error, never substitute estimates.
- **Cloudflare GraphQL Analytics** (https://developers.cloudflare.com/analytics/graphql-api/). The operator's own zone data through the operator's own token (Zone > Analytics > Read). Limits: "The default quota is 300 GraphQL queries over 5-minute window"; a zone-scoped query may include up to 10 zones. Cloudflare's API terms were NOT read for this pass (the tool reads only the zone the token owner configured; it is not a relay for other people's zones). Do not accept a zone id or token from callers. Open item: read Cloudflare's current self-serve subscription/API terms before turning this on publicly.
- **AI crawler operators (robots.txt tokens, audit only).** The audit only READS a site's robots.txt/llms.txt/sitemap and reports allow/block per documented token; it does not crawl at scale and does not impersonate any bot. OpenAI (https://developers.openai.com/api/docs/bots), Anthropic (https://support.claude.com/en/articles/8896518), Perplexity (https://docs.perplexity.ai/guides/bots), Google (https://developers.google.com/search/docs/crawling-indexing/google-common-crawlers), Bing (https://blogs.bing.com/webmaster/2022/4/Announcing-user-agent-change-for-Bing-crawler-bingbot/). Brave documents no crawler token: "The Brave Search crawler does not advertise a differentiated user agent" (https://search.brave.com/help/brave-search-crawler), so do not report a `Bravebot` rule as if it were official. Our own fetches go through `src/safe-fetch.ts` with an honest user agent; none of these operators' terms were found to restrict reading a public robots.txt.
- **llms.txt** (https://llmstxt.org/) is a proposal, not a standard-body spec; no terms. Drafted files contain only facts observed on the audited page.
- **Open items:** Naver terms, Yandex Webmaster agreement text, Cloudflare API terms, and whether the Anthropic Software Directory §3F blocker (above) applies to IndexNow/PSI/Cloudflare calls (it concerns endpoints the maintainer does not own; IndexNow and PSI endpoints are published for public use, Brave's is the unresolved one).
