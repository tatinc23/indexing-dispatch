import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { auditSite, aiBotRules, parseHtml, robotsSitemaps } from "../src/audit.js";
import { auditResultSchema } from "../src/contract.js";
import type { SafeFetchOptions, SafeFetchResult } from "../src/safe-fetch.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/audit/${name}`, import.meta.url), "utf8");

const reply = (r: Partial<SafeFetchResult> & { url?: string; body?: string; ct?: string }): SafeFetchResult => ({
  ok: (r.status ?? 200) >= 200 && (r.status ?? 200) < 300,
  status: r.status ?? 200,
  finalUrl: r.finalUrl ?? r.url ?? "",
  headers: r.headers ?? { "content-type": r.ct ?? "text/plain" },
  bodyText: r.bodyText ?? r.body ?? "",
  truncated: r.truncated ?? false,
  ...(r.blockedReason ? { blockedReason: r.blockedReason } : {}),
  ...(r.error ? { error: r.error } : {}),
});
const html = (body: string, extra: Partial<SafeFetchResult> = {}) => reply({ body, ct: "text/html; charset=utf-8", ...extra });
const notFound = () => reply({ status: 404, body: "not found", ct: "text/html" });

type Routes = Record<string, SafeFetchResult | ((url: string) => SafeFetchResult)>;
function fakeFetch(routes: Routes) {
  const calls: { url: string; opts?: SafeFetchOptions }[] = [];
  const fn = async (url: string, opts?: SafeFetchOptions): Promise<SafeFetchResult> => {
    calls.push({ url, opts });
    const hit = routes[url];
    const r = hit === undefined ? notFound() : typeof hit === "function" ? hit(url) : hit;
    return { ...r, finalUrl: r.finalUrl || url };
  };
  return { fn, calls };
}

const run = (routes: Routes, input: { targetUrl: string; strategy?: "mobile" | "desktop" } = { targetUrl: "https://example.com/" }, env: Record<string, string | undefined> = {}) => {
  const f = fakeFetch(routes);
  return auditSite(input, { safeFetch: f.fn, env, now: () => 1000 }).then((result) => ({ result, calls: f.calls }));
};
const ids = (r: { findings: { id: string }[] }) => r.findings.map((f) => f.id);

describe("parseHtml", () => {
  const p = parseHtml(fixture("home.html"), "https://example.com/");
  it("reads title, description, canonical, lang with entities decoded and whitespace collapsed", () => {
    assert.equal(p.title, "Example Widgets & Gadgets");
    assert.equal(p.description, 'We make widgets "by hand" & ship them.');
    assert.equal(p.canonical, "https://example.com/");
    assert.equal(p.lang, "en-US");
    assert.equal(p.hasOpenGraph, true);
  });
  it("collects JSON-LD @types from @graph, arrays and array-valued @type, skipping malformed blocks", () => {
    assert.deepEqual(p.jsonLdTypes, ["Organization", "WebSite", "Thing", "Product"]);
  });
  it("returns same-origin http(s) links only, deduped, without fragments", () => {
    assert.deepEqual(p.links, [
      { url: "https://example.com/about", text: "About us" },
      { url: "https://example.com/pricing", text: "Pricing" },
      { url: "https://example.com/contact", text: "Contact" },
    ]);
  });
  it("reports nothing for a bare page", () => {
    const b = parseHtml(fixture("bare.html"), "https://example.com/");
    assert.deepEqual(b, { title: undefined, description: undefined, canonical: undefined, lang: undefined, jsonLdTypes: [], hasOpenGraph: false, links: [] });
  });
  it("survives malformed-only JSON-LD and unusual shapes", () => {
    const wrap = (j: string) => `<html><head><script type="application/ld+json">${j}</script></head></html>`;
    for (const j of ["", "null", "42", '"str"', "{", '{"@type":5}', '{"@graph":"x"}', "[null,1,{}]"]) {
      assert.deepEqual(parseHtml(wrap(j), "https://example.com/").jsonLdTypes, [], j);
    }
    assert.deepEqual(parseHtml(wrap('{"@type":"Person"}'), "https://example.com/").jsonLdTypes, ["Person"]);
  });
  it("detects og: tags regardless of attribute order and quote style", () => {
    assert.equal(parseHtml("<meta content='x' property='og:image'>", "https://e.com/").hasOpenGraph, true);
    assert.equal(parseHtml('<meta name="og-not" content="x">', "https://e.com/").hasOpenGraph, false);
  });
});

describe("aiBotRules (robots.txt)", () => {
  it("is 'unspecified' for every bot when robots.txt is missing", () => {
    const r = aiBotRules(undefined);
    assert.deepEqual(Object.keys(r), ["GPTBot", "OAI-SearchBot", "ClaudeBot", "PerplexityBot", "Google-Extended", "Googlebot", "Bingbot"]);
    assert.ok(!("Bravebot" in r), "Brave documents no crawler token");
    assert.ok(Object.values(r).every((v) => v === "unspecified"));
  });
  it("a specific group beats the * group", () => {
    const r = aiBotRules(fixture("robots-mixed.txt"));
    assert.equal(r.GPTBot, "allowed"); // Allow: / (1) vs Disallow: /secret/ (not matching "/")
    assert.equal(r.ClaudeBot, "allowed"); // two User-agent lines share one group
    assert.equal(r.Bingbot, "blocked"); // case-insensitive agent match
    assert.equal(r.PerplexityBot, "blocked"); // falls back to * which has Disallow: /
    assert.equal(r.Googlebot, "blocked");
  });
  it("a * group that does not block / leaves bots unspecified", () => {
    const r = aiBotRules("User-agent: *\nDisallow: /admin/\n");
    assert.ok(Object.values(r).every((v) => v === "unspecified"));
  });
  it("a longer Allow beats a shorter Disallow; equal length goes to Allow", () => {
    assert.equal(aiBotRules("User-agent: GPTBot\nDisallow: /\nAllow: /\n").GPTBot, "allowed");
    assert.equal(aiBotRules("User-agent: GPTBot\nAllow: /\nDisallow: /\n").GPTBot, "allowed");
    assert.equal(aiBotRules("User-agent: GPTBot\nDisallow: /\nAllow: /$\n").GPTBot, "allowed"); // "/$" is longer and matches only "/"
    assert.equal(aiBotRules("User-agent: GPTBot\nDisallow: /\n").GPTBot, "blocked");
  });
  it("an empty Disallow allows everything; a bot-specific group with no match counts as allowed", () => {
    const r = aiBotRules("User-agent: *\nDisallow: /\n\nUser-agent: ClaudeBot\nDisallow:\n");
    assert.equal(r.ClaudeBot, "allowed");
    assert.equal(r.GPTBot, "blocked");
  });
  it("handles comments, CRLF, BOM, wildcards and repeated groups for one agent", () => {
    const txt = "﻿User-agent: gptbot # the openai one\r\nDisallow: /*\r\n\r\nUser-agent: GPTBot\r\nAllow: /public\r\n";
    assert.equal(aiBotRules(txt).GPTBot, "blocked");
  });
  it("ignores rules that appear before any User-agent line", () => {
    assert.equal(aiBotRules("Disallow: /\n").GPTBot, "unspecified");
  });
  it("extracts Sitemap lines in order", () => {
    assert.deepEqual(robotsSitemaps(fixture("robots-mixed.txt")), ["https://example.com/sitemap_index.xml", "https://cdn.other.test/sitemap.xml"]);
    assert.deepEqual(robotsSitemaps("User-agent: *\n"), []);
  });
});

const goodRoutes = (): Routes => ({
  "https://example.com/": html(fixture("home.html")),
  "https://example.com/llms.txt": reply({ body: "# Example\n", ct: "text/plain" }),
  "https://example.com/robots.txt": reply({ body: fixture("robots-mixed.txt") }),
  "https://example.com/sitemap_index.xml": reply({ body: '<?xml version="1.0"?><sitemapindex></sitemapindex>', ct: "application/xml" }),
});

describe("auditSite: observed facts", () => {
  it("returns a contract-valid result for a healthy page", async () => {
    const { result } = await run(goodRoutes());
    assert.equal(auditResultSchema.safeParse(result).success, true);
    assert.equal(result.status, "ok");
    assert.equal(result.httpStatus, 200);
    assert.equal(result.finalUrl, "https://example.com/");
    assert.equal(result.page?.title, "Example Widgets & Gadgets");
    assert.equal(result.page?.bytes, Buffer.byteLength(fixture("home.html")));
    assert.deepEqual(result.aiReadiness?.llmsTxt, { present: true, url: "https://example.com/llms.txt", bytes: 10 });
    assert.equal(result.aiReadiness?.robotsTxt.present, true);
    assert.deepEqual(result.aiReadiness?.sitemap, { present: true, url: "https://example.com/sitemap_index.xml" });
    assert.equal(result.durationMs, 0);
  });

  it("uses only same-origin Sitemap lines and falls back to /sitemap.xml", async () => {
    const routes = goodRoutes();
    routes["https://example.com/robots.txt"] = reply({ body: "User-agent: *\nSitemap: https://cdn.other.test/sitemap.xml\n" });
    routes["https://example.com/sitemap.xml"] = reply({ body: "<urlset></urlset>", ct: "application/xml" });
    const { result, calls } = await run(routes);
    assert.equal(result.aiReadiness?.sitemap.url, "https://example.com/sitemap.xml");
    assert.ok(calls.every((c) => !c.url.includes("other.test")));
  });

  it("fetches llms.txt, robots.txt and sitemap from the FINAL URL's origin, pinned to it", async () => {
    const routes: Routes = {
      "https://example.com/start": html("<html><title>Moved</title></html>", { finalUrl: "https://www.example.com/home" }),
      "https://www.example.com/llms.txt": reply({ body: "x" }),
      "https://www.example.com/robots.txt": reply({ body: "User-agent: *\n" }),
    };
    const { result, calls } = await run(routes, { targetUrl: "https://example.com/start" });
    assert.equal(result.finalUrl, "https://www.example.com/home");
    const sub = calls.slice(1);
    assert.deepEqual(sub.map((c) => c.url).sort(), ["https://www.example.com/llms.txt", "https://www.example.com/robots.txt", "https://www.example.com/sitemap.xml"]);
    assert.ok(sub.every((c) => c.opts?.allowedOrigin === "https://www.example.com"));
  });

  it("treats an HTML soft-404 at /llms.txt, /robots.txt and /sitemap.xml as not present", async () => {
    const soft = html("<!doctype html><html><body>Not here</body></html>");
    const { result } = await run({
      "https://example.com/": html(fixture("bare.html")),
      "https://example.com/llms.txt": soft,
      "https://example.com/robots.txt": soft,
      "https://example.com/sitemap.xml": soft,
    });
    assert.equal(result.aiReadiness?.llmsTxt.present, false);
    assert.equal(result.aiReadiness?.robotsTxt.present, false);
    assert.equal(result.aiReadiness?.sitemap.present, false);
    assert.ok(ids(result).includes("llms-txt-missing"));
  });

  it("flags a non-200 page but still audits it", async () => {
    const { result } = await run({ "https://example.com/": html("<title>Gone</title>", { status: 410 }) });
    assert.equal(result.status, "ok");
    assert.equal(result.httpStatus, 410);
    assert.ok(ids(result).includes("non-200"));
  });

  it("reports a blocked target as 'blocked' with the guard's reason, and does not fetch anything else", async () => {
    const { result, calls } = await run({ "https://example.com/": reply({ status: 0, blockedReason: "address 10.0.0.1 is private", body: "" }) });
    assert.equal(result.status, "blocked");
    assert.match(result.message, /10\.0\.0\.1/);
    assert.equal(calls.length, 1);
    assert.equal(result.page, undefined);
  });

  it("reports a network failure as 'unreachable'", async () => {
    const { result } = await run({ "https://example.com/": reply({ status: 0, error: "request timed out", body: "" }) });
    assert.equal(result.status, "unreachable");
    assert.match(result.message, /timed out/);
  });

  it("rejects an invalid URL as 'error' and a non-public one as 'blocked', before any fetch", async () => {
    const bad = await run({}, { targetUrl: "ftp://example.com/" });
    assert.equal(bad.result.status, "error");
    assert.equal(bad.calls.length, 0);
    for (const u of ["http://127.0.0.1/", "http://169.254.169.254/", "http://localhost/", "http://[::1]/"]) {
      const r = await run({}, { targetUrl: u });
      assert.equal(r.result.status, "blocked", u);
      assert.equal(r.calls.length, 0, u);
    }
    const creds = await run({}, { targetUrl: "https://a:b@example.com/" });
    assert.equal(creds.result.status, "error");
  });

  it("does not claim a file is missing when the fetch itself failed", async () => {
    const { result } = await run({
      "https://example.com/": html(fixture("bare.html")),
      "https://example.com/llms.txt": reply({ status: 0, error: "request timed out" }),
      "https://example.com/robots.txt": reply({ status: 503, body: "busy" }),
    });
    assert.ok(ids(result).includes("llms-txt-unchecked"));
    assert.ok(!ids(result).includes("llms-txt-missing"));
    assert.ok(ids(result).includes("robots-txt-unchecked"));
    assert.ok(!ids(result).includes("robots-txt-missing"));
  });
});

describe("auditSite: findings", () => {
  it("emits the expected ids for a bare page with no llms.txt/robots/sitemap", async () => {
    const { result } = await run({ "https://example.com/": html(fixture("bare.html")) });
    assert.deepEqual(ids(result), [
      "no-title",
      "no-meta-description",
      "no-canonical",
      "no-html-lang",
      "no-open-graph",
      "no-json-ld",
      "llms-txt-missing",
      "robots-txt-missing",
      "sitemap-missing",
      "ai-bots-unspecified",
    ]);
  });

  it("emits ai-bot-blocked:<Bot> for each blocked bot, in a fixed order", async () => {
    const { result } = await run(goodRoutes());
    assert.deepEqual(
      ids(result).filter((i) => i.startsWith("ai-bot")),
      ["ai-bot-blocked:OAI-SearchBot", "ai-bot-blocked:PerplexityBot", "ai-bot-blocked:Google-Extended", "ai-bot-blocked:Googlebot", "ai-bot-blocked:Bingbot"],
    );
  });

  it("is deterministic: same inputs give an identical result", async () => {
    const a = await run(goodRoutes());
    const b = await run(goodRoutes());
    assert.deepEqual(a.result, b.result);
  });

  it("has no findings about things that are present", async () => {
    const routes = goodRoutes();
    routes["https://example.com/robots.txt"] = reply({ body: "User-agent: *\nAllow: /\nSitemap: https://example.com/sitemap_index.xml\n" });
    const { result } = await run(routes);
    for (const bad of ["no-title", "no-meta-description", "no-json-ld", "llms-txt-missing", "robots-txt-missing", "sitemap-missing"]) assert.ok(!ids(result).includes(bad), bad);
  });
});

describe("auditSite: suggestedFiles (observed facts only)", () => {
  it("drafts llms.txt from the title, description, page URL and same-origin links", async () => {
    const routes = goodRoutes();
    routes["https://example.com/llms.txt"] = notFound();
    const { result } = await run(routes);
    const f = result.suggestedFiles.find((s) => s.kind === "llms.txt");
    assert.equal(f?.path, "/llms.txt");
    assert.equal(
      f?.content,
      [
        "# Example Widgets & Gadgets",
        "",
        '> We make widgets "by hand" & ship them.',
        "",
        "## Pages",
        "",
        "- [Example Widgets & Gadgets](https://example.com/)",
        "- [About us](https://example.com/about)",
        "- [Pricing](https://example.com/pricing)",
        "- [Contact](https://example.com/contact)",
        "",
      ].join("\n"),
    );
  });

  it("caps drafted links at 10 (plus the page's own entry)", async () => {
    const links = Array.from({ length: 30 }, (_, i) => `<a href="/p${i}">Page ${i}</a>`).join("");
    const { result } = await run({ "https://example.com/": html(`<html><head><title>T</title></head><body>${links}</body></html>`) });
    const f = result.suggestedFiles.find((s) => s.kind === "llms.txt")!;
    assert.equal(f.content.split("\n").filter((l) => l.startsWith("- [")).length, 11);
  });

  it("invents nothing when the page has no title or description", async () => {
    const { result } = await run({ "https://example.com/": html(fixture("bare.html")) });
    const llms = result.suggestedFiles.find((s) => s.kind === "llms.txt")!;
    assert.equal(llms.content, "# example.com\n\n## Pages\n\n- [https://example.com/](https://example.com/)\n");
    const ld = result.suggestedFiles.find((s) => s.kind === "json-ld")!;
    assert.deepEqual(JSON.parse(ld.content), { "@context": "https://schema.org", "@type": "WebSite", url: "https://example.com" });
    assert.ok(!/Organization|rating|score|founder|logo/i.test(ld.content + llms.content));
  });

  it("JSON-LD snippet uses only observed title, URL and description", async () => {
    const routes = goodRoutes();
    routes["https://example.com/"] = html('<html><head><title>My Site</title><meta name="description" content="About things."></head></html>');
    const { result } = await run(routes);
    const ld = result.suggestedFiles.find((s) => s.kind === "json-ld")!;
    assert.equal(ld.path, "head:ld+json");
    assert.deepEqual(JSON.parse(ld.content), { "@context": "https://schema.org", "@type": "WebSite", name: "My Site", url: "https://example.com", description: "About things." });
  });

  it("suggests nothing for files and markup that already exist", async () => {
    const routes = goodRoutes();
    routes["https://example.com/robots.txt"] = reply({
      body: ["GPTBot", "OAI-SearchBot", "ClaudeBot", "PerplexityBot", "Google-Extended"].map((b) => `User-agent: ${b}\nAllow: /\n`).join("\n"),
    });
    const { result } = await run(routes);
    assert.deepEqual(result.suggestedFiles, []);
  });

  it("suggests explicit Allow rules only for AI bots that are blocked or unspecified", async () => {
    const { result } = await run(goodRoutes()); // GPTBot/ClaudeBot explicit; the rest blocked via *
    const r = result.suggestedFiles.find((s) => s.kind === "robots.txt")!;
    assert.equal(r.path, "/robots.txt (append)");
    assert.equal(r.content, "User-agent: OAI-SearchBot\nAllow: /\n\nUser-agent: PerplexityBot\nAllow: /\n");
    assert.ok(!/GPTBot|ClaudeBot|Google-Extended|Googlebot|Bingbot|Bravebot/.test(r.content)); // training crawlers are the owner's call
  });

  it("uses the plain /robots.txt path when the file does not exist", async () => {
    const { result } = await run({ "https://example.com/": html(fixture("bare.html")) });
    const r = result.suggestedFiles.find((s) => s.kind === "robots.txt")!;
    assert.equal(r.path, "/robots.txt");
    assert.match(r.content, /User-agent: OAI-SearchBot\nAllow: \/\n/);
    assert.ok(!/GPTBot|ClaudeBot|Google-Extended/.test(r.content));
  });
});

describe("auditSite: PageSpeed Insights", () => {
  const page = (): Routes => ({ "https://example.com/": html(fixture("bare.html")) });

  it("is skipped when PAGESPEED_API_KEY is not set, and makes no PSI call", async () => {
    const { result, calls } = await run(page());
    assert.deepEqual(result.pageSpeed, { status: "skipped", reason: "PAGESPEED_API_KEY not set" });
    assert.ok(calls.every((c) => !c.url.includes("googleapis")));
    const blank = await run(page(), undefined, { PAGESPEED_API_KEY: "  " });
    assert.equal(blank.result.pageSpeed?.status, "skipped");
  });

  const psiUrl = (strategy: string) => (u: string) => {
    assert.match(u, /^https:\/\/www\.googleapis\.com\/pagespeedonline\/v5\/runPagespeed\?/);
    const q = new URL(u).searchParams;
    assert.equal(q.get("url"), "https://example.com/");
    assert.equal(q.get("strategy"), strategy);
    assert.deepEqual(q.getAll("category"), ["PERFORMANCE", "SEO"]);
    assert.equal(q.get("key"), "SECRET-KEY");
    return reply({ body: fixture("psi-ok.json"), ct: "application/json" });
  };
  const psiKey = (r: Record<string, string>) => ({ PAGESPEED_API_KEY: "SECRET-KEY", ...r });

  it("maps a real-shaped response to contract fields (scores 0-100, times in ms) with a 25 s timeout", async () => {
    const routes = page();
    const f = fakeFetch(routes);
    const inner = f.fn;
    let psiOpts: SafeFetchOptions | undefined;
    const r = await auditSite(
      { targetUrl: "https://example.com/" },
      {
        env: psiKey({}),
        now: () => 0,
        safeFetch: async (u, o) => {
          if (u.includes("googleapis")) {
            psiOpts = o;
            return { ...psiUrl("MOBILE")(u), finalUrl: u };
          }
          return inner(u, o);
        },
      },
    );
    assert.deepEqual(r.pageSpeed, { status: "ok", strategy: "mobile", performanceScore: 87, seoScore: 92, lcpMs: 2413, cls: 0.031, tbtMs: 140, ttfbMs: 318 });
    assert.equal(psiOpts?.timeoutMs, 25_000);
    assert.equal(auditResultSchema.safeParse(r).success, true);
    assert.ok(!JSON.stringify(r).includes("SECRET-KEY"));
  });

  it("honours strategy=desktop", async () => {
    const f = fakeFetch(page());
    const r = await auditSite(
      { targetUrl: "https://example.com/", strategy: "desktop" },
      { env: psiKey({}), safeFetch: async (u, o) => (u.includes("googleapis") ? psiUrl("DESKTOP")(u) : f.fn(u, o)) },
    );
    assert.equal(r.pageSpeed?.strategy, "desktop");
  });

  it("omits metrics the response does not contain rather than inventing them", async () => {
    const f = fakeFetch(page());
    const r = await auditSite(
      { targetUrl: "https://example.com/" },
      {
        env: psiKey({}),
        safeFetch: async (u, o) => (u.includes("googleapis") ? reply({ body: JSON.stringify({ lighthouseResult: { categories: { performance: { score: 0.5 } }, audits: {} } }) }) : f.fn(u, o)),
      },
    );
    assert.deepEqual(r.pageSpeed, { status: "ok", strategy: "mobile", performanceScore: 50 });
  });

  const psiError = async (response: SafeFetchResult) => {
    const f = fakeFetch(page());
    return auditSite({ targetUrl: "https://example.com/" }, { env: psiKey({}), safeFetch: async (u, o) => (u.includes("googleapis") ? response : f.fn(u, o)) });
  };

  it("returns status 'error' with a reason for HTTP errors, bad JSON, missing data, timeouts and blocks", async () => {
    const cases: [SafeFetchResult, RegExp][] = [
      [reply({ status: 429, body: JSON.stringify({ error: { message: "Quota exceeded" } }) }), /429.*Quota exceeded/],
      [reply({ status: 400, body: "<html>bad</html>" }), /400/],
      [reply({ body: "{not json" }), /not valid JSON/i],
      [reply({ body: "{}" }), /no lighthouse/i],
      [reply({ body: "{}", truncated: true }), /too large/i],
      [reply({ status: 0, error: "request timed out" }), /timed out/],
      [reply({ status: 0, blockedReason: "blocked" }), /blocked/],
    ];
    for (const [resp, re] of cases) {
      const r = await psiError(resp);
      assert.equal(r.pageSpeed?.status, "error", JSON.stringify(resp));
      assert.match(r.pageSpeed?.reason ?? "", re);
      assert.equal(r.pageSpeed?.performanceScore, undefined);
      assert.equal(r.status, "ok"); // a PSI failure never fails the audit
      assert.ok(!JSON.stringify(r).includes("SECRET-KEY"));
    }
  });

  it("does not leak the key even if the fetcher throws", async () => {
    const f = fakeFetch(page());
    const r = await auditSite(
      { targetUrl: "https://example.com/" },
      {
        env: psiKey({}),
        safeFetch: async (u, o) => {
          if (u.includes("googleapis")) throw new Error(`boom ${u}`);
          return f.fn(u, o);
        },
      },
    );
    assert.equal(r.pageSpeed?.status, "error");
    assert.ok(!JSON.stringify(r).includes("SECRET-KEY"));
  });

  it("is not run when the page itself was blocked or unreachable", async () => {
    const { result, calls } = await run({ "https://example.com/": reply({ status: 0, error: "x" }) }, undefined, { PAGESPEED_API_KEY: "k" });
    assert.equal(result.pageSpeed, undefined);
    assert.equal(calls.length, 1);
  });
});

describe("pathological input stays linear", () => {
  const MAX_MS = 250;
  const timed = <T,>(label: string, fn: () => T): T => {
    const t0 = performance.now();
    const out = fn();
    const ms = performance.now() - t0;
    assert.ok(ms < MAX_MS, `${label} took ${Math.round(ms)} ms`);
    return out;
  };
  const kb400 = 400 * 1024;
  const repeat = (unit: string, bytes: number) => unit.repeat(Math.ceil(bytes / unit.length));
  const cases: Record<string, string> = {
    "<a  repeated": repeat("<a ", kb400),
    "<script repeated": repeat("<script", kb400),
    "<!-- repeated": repeat("<!--", kb400),
    '<a href="x"> without </a>': repeat('<a href="x">', kb400),
    "<script> without </script>": repeat("<script>", kb400),
    "<title> without </title>": repeat("<title>", kb400),
    "<meta repeated": repeat("<meta ", kb400),
    "a long open tag with a late >": `${repeat("<a ", kb400)}>`,
    "many < with no tag name": repeat("< ", kb400),
    "unclosed attribute quotes": `<a href="${repeat('x" y="', kb400)}`,
    "entity-like runs": repeat("&", kb400),
  };
  for (const [label, input] of Object.entries(cases)) {
    it(`parseHtml: ${label}`, () => {
      timed(label, () => parseHtml(input, "https://example.com/"));
    });
  }

  it("a whole audit of a pathological page finishes quickly and says it only looked at the start", async () => {
    const big = repeat('<a href="x">', kb400);
    const t0 = performance.now();
    const { result } = await run({ "https://example.com/": html(big) });
    assert.ok(performance.now() - t0 < MAX_MS);
    assert.equal(result.page?.bytes, Buffer.byteLength(big));
    assert.ok(ids(result).includes("page-truncated"));
  });

  it("does not report truncation for a normal page", async () => {
    const { result } = await run(goodRoutes());
    assert.ok(!ids(result).includes("page-truncated"));
  });

  it("only parses the first 256 KB of HTML", () => {
    const late = `${" ".repeat(300 * 1024)}<title>Too late</title>`;
    assert.equal(parseHtml(late, "https://example.com/").title, undefined);
    const early = `<title>Early</title>${" ".repeat(300 * 1024)}`;
    assert.equal(parseHtml(early, "https://example.com/").title, "Early");
  });

  it("robots.txt: 1 MB of User-agent lines", () => {
    const robots = repeat("User-agent: GPTBot\n", 1024 * 1024);
    timed("robots user-agent lines", () => aiBotRules(robots));
    timed("robots sitemap lines", () => robotsSitemaps(repeat("Sitemap: https://example.com/s.xml\n", 1024 * 1024)));
  });

  it("robots.txt: alternating groups, huge wildcard patterns and one enormous line", () => {
    timed("alternating", () => aiBotRules(repeat("User-agent: GPTBot\nDisallow: /a*b*c*\n", 1024 * 1024)));
    timed("wildcards", () => aiBotRules(`User-agent: *\nDisallow: /${"*a".repeat(500_000)}\n`));
    timed("one line", () => aiBotRules(`User-agent: ${"x".repeat(1024 * 1024)}`));
    timed("hashes", () => aiBotRules(repeat("#", 1024 * 1024)));
  });

  it("robots.txt: a pathological file through a full audit", async () => {
    const routes = goodRoutes();
    routes["https://example.com/robots.txt"] = reply({ body: repeat("User-agent:", 1024 * 1024) });
    const t0 = performance.now();
    const { result } = await run(routes);
    assert.ok(performance.now() - t0 < MAX_MS);
    assert.equal(result.status, "ok");
  });

  it("llms.txt and sitemap bodies of 1 MB are handled quickly", async () => {
    const routes = goodRoutes();
    routes["https://example.com/llms.txt"] = reply({ body: repeat("<", 1024 * 1024) });
    routes["https://example.com/sitemap_index.xml"] = reply({ body: repeat("<urlset", 1024 * 1024).replace("<urlset", "<url"), ct: "application/xml" });
    const t0 = performance.now();
    await run(routes);
    assert.ok(performance.now() - t0 < MAX_MS);
  });
});

describe("parseHtml: unchanged results on ordinary pages", () => {
  it("full parse of the fixture", () => {
    assert.deepEqual(parseHtml(fixture("home.html"), "https://example.com/"), {
      title: "Example Widgets & Gadgets",
      description: 'We make widgets "by hand" & ship them.',
      canonical: "https://example.com/",
      lang: "en-US",
      jsonLdTypes: ["Organization", "WebSite", "Thing", "Product"],
      hasOpenGraph: true,
      links: [
        { url: "https://example.com/about", text: "About us" },
        { url: "https://example.com/pricing", text: "Pricing" },
        { url: "https://example.com/contact", text: "Contact" },
      ],
    });
  });

  it("handles upper-case tags, nested markup in anchors, scripts that mention tags, and comments", () => {
    const page = `<HTML LANG="fr"><HEAD><TITLE>Un titre</TITLE>
      <SCRIPT>var s = "<a href='/trap'>trap</a><title>Nope</title>";</SCRIPT>
      <STYLE>a::after { content: "<a href='/css'>" }</STYLE></HEAD>
      <BODY><!-- <a href="/commented">no</a> -->
      <A HREF="/x?y=1#z"><span>Nested</span> <b>text</b></A><a href="/y">Second</a></BODY></HTML>`;
    assert.deepEqual(parseHtml(page, "https://example.com/dir/"), {
      title: "Un titre",
      description: undefined,
      canonical: undefined,
      lang: "fr",
      jsonLdTypes: [],
      hasOpenGraph: false,
      links: [
        { url: "https://example.com/x?y=1", text: "Nested text" },
        { url: "https://example.com/y", text: "Second" },
      ],
    });
  });
});

describe("parseHtml: HTML entities in extracted values", () => {
  const page = `<!doctype html><html lang="en&#45;US"><head>
<title>TAT Inc &mdash; AI products &amp; software &#8212; &#x2014; done</title>
<meta name="description" content="It&rsquo;s &quot;real&quot; &lt;b&gt;work&lt;/b&gt; &#8212; &#x2014; &amp;amp; more">
<link rel="canonical" href="https://example.com/a?x=1&amp;y=2&#38;z=3">
</head><body><a href="/p?a=1&amp;b=2">Pricing &amp; plans</a></body></html>`;
  const p = parseHtml(page, "https://example.com/");

  it("decodes named and numeric entities in the title", () => {
    assert.equal(p.title, "TAT Inc — AI products & software — — done");
  });
  it("decodes named and numeric entities in the meta description, once (no double decoding)", () => {
    assert.equal(p.description, "It’s \"real\" <b>work</b> — — &amp; more");
  });
  it("decodes entities in canonical and lang", () => {
    assert.equal(p.canonical, "https://example.com/a?x=1&y=2&z=3");
    assert.equal(p.lang, "en-US");
  });
  it("decodes entities in same-origin link hrefs and text", () => {
    assert.deepEqual(p.links, [{ url: "https://example.com/p?a=1&b=2", text: "Pricing & plans" }]);
  });
  it("leaves unknown, malformed, out-of-range and surrogate entities as written", () => {
    const q = parseHtml(`<title>a &bogus; b &amp c &#0; &#1114112; &#xD800; &#; &#x; &</title>`, "https://example.com/");
    assert.equal(q.title, "a &bogus; b &amp c &#0; &#1114112; &#xD800; &#; &#x; &");
  });
  it("decoded values feed the suggested llms.txt and JSON-LD drafts", async () => {
    const { result } = await run({ "https://example.com/": html(page) });
    const llms = result.suggestedFiles.find((f) => f.kind === "llms.txt")!;
    assert.match(llms.content, /^# TAT Inc — AI products & software/);
    assert.match(llms.content, /> It’s "real" <b>work<\/b>/);
    assert.doesNotMatch(llms.content, /&(mdash|rsquo|quot|#8212|#x2014);/);
    const ld = JSON.parse(result.suggestedFiles.find((f) => f.kind === "json-ld")!.content);
    assert.equal(ld.name, "TAT Inc — AI products & software — — done");
    assert.equal(result.page?.title, "TAT Inc — AI products & software — — done");
    assert.equal(result.page?.canonical, "https://example.com/a?x=1&y=2&z=3");
  });
  it("stays linear on a megabyte of ampersands", () => {
    const t0 = Date.now();
    const q = parseHtml(`<title>${"&".repeat(200_000)}</title><meta name="description" content="${"&#".repeat(2000)}">`, "https://example.com/");
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(q.title?.length, 2000); // title is bounded to 2000 characters before decoding
  });
});
