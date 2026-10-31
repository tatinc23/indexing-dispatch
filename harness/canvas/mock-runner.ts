// MOCK tool results for the harness only. Not imported by the shipped view. Every value here is invented for
// layout testing and the harness page says so on screen.
import type { AuditResult, CloudflareBaseline, IndexNowResult } from "../../src/contract.js";
import type { SubmitResult } from "../../src/schema.js";
import type { Runner } from "../../views/render-submission-canvas/Canvas.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Scenario switches (query params in main.tsx). All values below stay invented; the harness page says so on screen. */
export interface Scenario {
  brave?: "mixed" | "accepted" | "rejected" | "error";
  indexnow?: "ok" | "key_not_verified" | "rejected";
  audit?: "findings" | "clean" | "unreachable";
}

export function mockRunner(delay = 500, sc: Scenario = {}): Runner {
  let braveCalls = 0;
  return {
    async brave({ targetUrl }) {
      await wait(delay);
      const n = braveCalls++;
      const base = { targetUrl, durationMs: 18400, diagnostics: undefined };
      if (sc.brave === "accepted") {
        return { ...base, status: "accepted", message: "Brave showed a success confirmation.", confirmationText: "Thank you for your submission." } satisfies SubmitResult;
      }
      if (sc.brave === "rejected") {
        return { ...base, status: "rejected", message: "Brave showed an error for this URL.", diagnostics: { observed: ["Error"], screenshotAttached: false } } satisfies SubmitResult;
      }
      if (sc.brave === "error") {
        return { ...base, status: "error", errorCode: "rate_limited", message: "This server's hourly Brave limit was reached.", retryAfterSeconds: 1800 } satisfies SubmitResult;
      }
      if (n === 0) {
        return { ...base, status: "accepted", message: "Brave showed a success confirmation.", confirmationText: "Thank you for your submission." } satisfies SubmitResult;
      }
      if (n === 1) {
        return {
          ...base,
          status: "timeout",
          message: "No definitive state before the deadline.",
          durationMs: 80000,
          diagnostics: { observed: ["Verifying...", "Verifying..."], domExcerpt: "Verifying...", screenshotAttached: false },
        } satisfies SubmitResult;
      }
      return { ...base, status: "rejected", message: "Brave showed an error for this URL.", diagnostics: { observed: ["Error"], screenshotAttached: false } } satisfies SubmitResult;
    },
    async indexNow({ host, urls, key }) {
      await wait(delay);
      if (sc.indexnow === "key_not_verified") {
        return { status: "key_not_verified", host, urlCount: urls.length, keyLocation: `https://${host}/${key}.txt`, keyVerified: false, engines: [], message: "The key file did not contain the key. Nothing was sent.", durationMs: 420 } satisfies IndexNowResult;
      }
      if (sc.indexnow === "rejected") {
        return { status: "rejected", host, urlCount: urls.length, keyLocation: `https://${host}/${key}.txt`, keyVerified: true, engines: [{ engine: "api.indexnow.org", endpoint: "https://api.indexnow.org/indexnow", ok: false, httpStatus: 422, message: "URLs do not belong to the host." }], message: "IndexNow rejected the request.", durationMs: 900 } satisfies IndexNowResult;
      }
      return {
        status: "submitted",
        host,
        urlCount: urls.length,
        keyLocation: `https://${host}/${key}.txt`,
        keyVerified: true,
        engines: [
          { engine: "api.indexnow.org", endpoint: "https://api.indexnow.org/indexnow", ok: true, httpStatus: 200, message: "Accepted." },
          { engine: "www.bing.com", endpoint: "https://www.bing.com/indexnow", ok: false, httpStatus: 429, message: "Too many requests." },
        ],
        message: `Submitted ${urls.length} URL(s); 1 of 2 endpoints answered OK.`,
        durationMs: 1300,
      } satisfies IndexNowResult;
    },
    async audit({ targetUrl, strategy }): Promise<AuditResult> {
      await wait(delay);
      const host = new URL(targetUrl).host;
      if (sc.audit === "unreachable") {
        return { status: "unreachable", targetUrl, message: "Could not connect to the host.", findings: [], suggestedFiles: [], durationMs: 5000 } satisfies AuditResult;
      }
      if (sc.audit === "clean") {
        return {
          status: "ok",
          targetUrl,
          finalUrl: targetUrl,
          httpStatus: 200,
          message: "Read the page and 3 site files.",
          page: { title: "Example Co", description: "Example Co makes example things.", canonical: targetUrl, lang: "en", jsonLdTypes: ["Organization", "WebSite"], hasOpenGraph: true, bytes: 48211 },
          aiReadiness: {
            llmsTxt: { present: true, url: `https://${host}/llms.txt`, bytes: 812 },
            robotsTxt: { present: true, url: `https://${host}/robots.txt`, aiBots: { GPTBot: "allowed", ClaudeBot: "allowed" } },
            sitemap: { present: true, url: `https://${host}/sitemap.xml` },
          },
          findings: [{ id: "og-present", severity: "info", message: "Open Graph tags are present." }],
          suggestedFiles: [],
          durationMs: 1900,
        } satisfies AuditResult;
      }
      return {
        status: "ok",
        targetUrl,
        finalUrl: targetUrl,
        httpStatus: 200,
        message: "Read the page and 3 site files.",
        page: { title: "Example Co", description: "Example Co makes example things.", canonical: targetUrl, lang: "en", jsonLdTypes: ["Organization"], hasOpenGraph: true, bytes: 48211 },
        aiReadiness: {
          llmsTxt: { present: false, url: `https://${host}/llms.txt` },
          robotsTxt: { present: true, url: `https://${host}/robots.txt`, aiBots: { GPTBot: "allowed", ClaudeBot: "unspecified", PerplexityBot: "blocked", Bravebot: "allowed" } },
          sitemap: { present: true, url: `https://${host}/sitemap.xml` },
        },
        pageSpeed: strategy
          ? { status: "ok", strategy, performanceScore: 88, seoScore: 100, lcpMs: 2300, cls: 0.02, tbtMs: 120, ttfbMs: 310 }
          : { status: "skipped", reason: "PAGESPEED_API_KEY not set" },
        findings: [
          { id: "llms-txt-missing", severity: "missing", message: "No /llms.txt was found." },
          { id: "perplexity-blocked", severity: "warn", message: "robots.txt blocks PerplexityBot." },
          { id: "og-present", severity: "info", message: "Open Graph tags are present." },
        ],
        suggestedFiles: [
          { path: "/llms.txt", kind: "llms.txt", content: `# Example Co\n\n> Example Co makes example things.\n\n- [Home](${targetUrl})\n` },
          { path: "/robots.txt (append)", kind: "robots.txt", content: "User-agent: PerplexityBot\nAllow: /\n" },
        ],
        durationMs: 2100,
      } satisfies AuditResult;
    },
    async cloudflare({ zoneId, previous }) {
      await wait(delay);
      return {
        status: "ok",
        message: "Baseline recorded for the last 7 days.",
        zoneId,
        windowStart: "2026-10-20T00:00:00Z",
        windowEnd: "2026-10-27T00:00:00Z",
        totals: { requests: 12840, bytes: 93482112, uniques: 2210 },
        aiBots: [
          { name: "GPTBot", requests: 140 },
          { name: "ClaudeBot", requests: 62 },
        ],
        ...(previous ? { deltaVsPrevious: { requests: 100, bytes: 1000, aiBotRequests: 10 } } : {}),
      } satisfies CloudflareBaseline;
    },
  };
}
