import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AuditResult, CloudflareBaseline, IndexNowResult } from "../src/contract.js";
import type { SubmitResult } from "../src/schema.js";
import {
  auditPhase,
  bravePhase,
  braveSummary,
  braveTotals,
  buildPatchTabs,
  buildSocialDrafts,
  buildRecheckPrompt,
  cloudflarePhase,
  domainLabel,
  gapCount,
  indexNowKeyProblem,
  indexNowPhase,
  initialUrlText,
  normalizeProps,
  parseUrlList,
  planIndexNow,
  suggestedFilesBundle,
  unitStatus,
  urlsWithFacts,
  xWeightedLength,
  X_LIMIT,
  UNITS,
  type ToolPhase,
} from "../views/render-submission-canvas/lib.js";

const brave = (status: SubmitResult["status"], url = "https://example.com/"): SubmitResult => ({
  targetUrl: url,
  status,
  message: "m",
  durationMs: 1000,
});

describe("normalizeProps", () => {
  it("treats missing enabledTools as disabled", () => {
    const p = normalizeProps({ initialUrls: ["https://a.example/"] });
    assert.deepEqual(p.enabledTools, { cloudflare: false, pageSpeed: false });
    assert.equal(p.mode, "interactive");
  });
  it("survives garbage", () => {
    const p = normalizeProps(null);
    assert.deepEqual(p.initialUrls, []);
    assert.equal(normalizeProps({ enabledTools: { cloudflare: "yes" } }).enabledTools.cloudflare, false);
  });
  it("prefills https://domain/ only when no URLs were passed", () => {
    assert.equal(initialUrlText(normalizeProps({ domain: "example.com" })), "https://example.com/");
    assert.equal(initialUrlText(normalizeProps({ domain: "example.com", initialUrls: ["https://x.example/a"] })), "https://x.example/a");
    assert.equal(initialUrlText(normalizeProps({})), "");
  });
});

describe("parseUrlList", () => {
  it("keeps valid URLs in order, drops duplicates, reports problems by line", () => {
    const r = parseUrlList("https://a.example/\nnot a url\nhttps://a.example/\nftp://b.example/x\nhttp://localhost:3000\nhttps://c.example/p, https://d.example/");
    assert.deepEqual(r.urls, ["https://a.example/", "https://c.example/p", "https://d.example/"]);
    assert.equal(r.duplicates, 1);
    assert.deepEqual(
      r.problems.map((p) => [p.line, p.value]),
      [
        [2, "not"],
        [2, "a"],
        [2, "url"],
        [4, "ftp://b.example/x"],
        [5, "http://localhost:3000"],
      ],
    );
  });
  it("rejects embedded credentials", () => {
    assert.equal(parseUrlList("https://user:pw@a.example/").urls.length, 0);
  });
});

describe("IndexNow plan", () => {
  const key = "abcd1234efgh5678";
  it("requires a key and never invents one", () => {
    assert.equal(planIndexNow(["https://a.example/"], "", "").ok, false);
    assert.match(indexNowKeyProblem("short") ?? "", /8 to 128/);
    assert.match(indexNowKeyProblem("has space 12345") ?? "", /letters, digits/);
    assert.equal(indexNowKeyProblem(key), null);
  });
  it("requires one host", () => {
    const p = planIndexNow(["https://a.example/", "https://b.example/"], key, "");
    assert.equal(p.ok, false);
    assert.match(p.problem ?? "", /one host/);
  });
  it("omits keyLocation unless typed, and keeps it on the same host", () => {
    const ok = planIndexNow(["https://a.example/x"], key, "");
    assert.deepEqual(ok.args, { host: "a.example", key, urls: ["https://a.example/x"] });
    const loc = planIndexNow(["https://a.example/x"], key, "https://a.example/keys/k.txt");
    assert.equal(loc.args?.keyLocation, "https://a.example/keys/k.txt");
    assert.equal(planIndexNow(["https://a.example/x"], key, "https://other.example/k.txt").ok, false);
    assert.equal(planIndexNow(["https://a.example/x"], key, "nope").ok, false);
  });
  it("caps at 100 URLs", () => {
    const urls = Array.from({ length: 101 }, (_, i) => `https://a.example/${i}`);
    assert.equal(planIndexNow(urls, key, "").ok, false);
  });
});

describe("phases", () => {
  it("brave: ready only when every result is accepted", () => {
    assert.equal(bravePhase([]), "idle");
    assert.equal(bravePhase([brave("accepted"), brave("accepted")]), "ready");
    assert.equal(bravePhase([brave("accepted"), brave("timeout")]), "warning");
    assert.equal(bravePhase([brave("accepted"), brave("verification_required")]), "warning");
    assert.equal(bravePhase([brave("accepted"), brave("error")]), "error");
    assert.equal(braveSummary([brave("accepted"), brave("rejected")], 3), "1 of 3 accepted, 1 not run");
  });
  it("indexnow", () => {
    const base: IndexNowResult = { status: "submitted", host: "a.example", urlCount: 1, keyLocation: "k", keyVerified: true, engines: [{ engine: "e", endpoint: "x", ok: true, message: "" }], message: "", durationMs: 1 };
    assert.equal(indexNowPhase(base), "ready");
    assert.equal(indexNowPhase({ ...base, engines: [...base.engines, { engine: "f", endpoint: "y", ok: false, message: "" }] }), "warning");
    assert.equal(indexNowPhase({ ...base, status: "key_not_verified", keyVerified: false, engines: [] }), "warning");
    assert.equal(indexNowPhase({ ...base, status: "rejected" }), "error");
  });
  it("audit and cloudflare", () => {
    const a: AuditResult = { status: "ok", targetUrl: "https://a.example/", message: "", findings: [{ id: "i", severity: "info", message: "" }], suggestedFiles: [], durationMs: 1 };
    assert.equal(auditPhase(a), "ready");
    assert.equal(auditPhase({ ...a, findings: [{ id: "x", severity: "missing", message: "" }] }), "warning");
    assert.equal(auditPhase({ ...a, status: "blocked" }), "error");
    assert.equal(cloudflarePhase({ status: "ok", message: "" }), "ready");
    assert.equal(cloudflarePhase({ status: "not_configured", message: "" }), "warning");
    assert.equal(cloudflarePhase({ status: "error", message: "" }), "error");
  });
});

const auditOk = (over: Partial<AuditResult> = {}): AuditResult => ({
  status: "ok",
  targetUrl: "https://a.example/",
  httpStatus: 200,
  message: "",
  page: { title: "Example", description: "A page.", jsonLdTypes: ["Organization"], hasOpenGraph: true, bytes: 1 },
  aiReadiness: { llmsTxt: { present: false, url: "https://a.example/llms.txt" }, robotsTxt: { present: true, url: "x", aiBots: {} }, sitemap: { present: false } },
  findings: [
    { id: "a", severity: "missing", message: "m" },
    { id: "b", severity: "warn", message: "w" },
    { id: "c", severity: "info", message: "i" },
  ],
  suggestedFiles: [],
  durationMs: 1,
  ...over,
});
const inow = (over: Partial<IndexNowResult> = {}): IndexNowResult => ({
  status: "submitted",
  host: "a.example",
  urlCount: 1,
  keyLocation: "https://a.example/k.txt",
  keyVerified: true,
  engines: [{ engine: "api.indexnow.org", endpoint: "e", ok: true, message: "" }],
  message: "",
  durationMs: 1,
  ...over,
});

describe("social drafts", () => {
  it("is null without an observed result for that URL", () => {
    assert.equal(buildSocialDrafts({ brave: [], audits: [] }, "https://a.example/"), null);
    assert.equal(buildSocialDrafts({ brave: [brave("accepted", "https://b.example/")], audits: [] }, "https://a.example/"), null);
    assert.deepEqual(urlsWithFacts({ brave: [brave("accepted", "https://b.example/")], audits: [auditOk()] }), ["https://b.example/", "https://a.example/"]);
  });
  it("reports non-accepted Brave outcomes as what they were", () => {
    const d = buildSocialDrafts({ brave: [brave("timeout", "https://a.example/")], audits: [] }, "https://a.example/");
    assert.ok(d);
    assert.match(d.x, /Brave Search submit form: gave no answer before the time limit\./);
    assert.doesNotMatch(d.x, /accepted/);
    const r = buildSocialDrafts({ brave: [brave("rejected", "https://a.example/")], audits: [] }, "https://a.example/");
    assert.match(r?.x ?? "", /rejected\./);
  });
  it("uses only observed facts and never claims indexing, ranking or going live", () => {
    const facts = { brave: [brave("accepted", "https://a.example/")], indexNow: inow(), indexNowUrls: ["https://a.example/"], audits: [auditOk()] };
    const d = buildSocialDrafts(facts, "https://a.example/");
    assert.ok(d);
    const all = `${d.x}\n${d.linkedin}`;
    assert.match(d.x, /^https:\/\/a\.example\/\nBrave Search submit form: accepted\./);
    assert.match(d.x, /IndexNow: submitted \(1 of 1 endpoint answered OK\)\./);
    assert.match(d.x, /Audit: llms\.txt not found, 2 gaps flagged\./);
    assert.match(d.linkedin, /Checked Example \(https:\/\/a\.example\/\)\./);
    assert.match(d.linkedin, /HTTP 200; llms\.txt not found; sitemap not found; JSON-LD: Organization; 2 gaps flagged/);
    assert.doesNotMatch(all, /\b(live|indexed|ranking|ranked|officially|deployed|free|receipts?|visitors?|PageSpeed)\b/i);
  });
  it("leaves out IndexNow when that URL was not in the request and when nothing was sent", () => {
    const d1 = buildSocialDrafts({ brave: [brave("accepted", "https://a.example/")], indexNow: inow(), indexNowUrls: ["https://a.example/other"], audits: [] }, "https://a.example/");
    assert.doesNotMatch(d1?.x ?? "", /IndexNow/);
    const d2 = buildSocialDrafts({ brave: [], indexNow: inow({ status: "key_not_verified", keyVerified: false, engines: [] }), indexNowUrls: ["https://a.example/"], audits: [] }, "https://a.example/");
    assert.match(d2?.x ?? "", /IndexNow: not sent, the key file was not verified\./);
  });
  it("includes PageSpeed only when a real score exists, and only in the LinkedIn draft", () => {
    const withPs = auditOk({ pageSpeed: { status: "ok", strategy: "mobile", performanceScore: 91 } });
    const d = buildSocialDrafts({ brave: [], audits: [withPs] }, "https://a.example/");
    assert.match(d?.linkedin ?? "", /PageSpeed performance 91 \(mobile\)/);
    assert.doesNotMatch(d?.x ?? "", /PageSpeed/);
    const skipped = buildSocialDrafts({ brave: [], audits: [auditOk({ pageSpeed: { status: "skipped", reason: "no key" } })] }, "https://a.example/");
    assert.doesNotMatch(skipped?.linkedin ?? "", /PageSpeed/);
  });
  it("keeps the X draft within 280 and reports a matching count", () => {
    const longUrl = `https://a.example/${"p".repeat(400)}`;
    const facts = { brave: [brave("accepted", longUrl)], indexNow: inow(), indexNowUrls: [longUrl], audits: [auditOk({ targetUrl: longUrl })] };
    const d = buildSocialDrafts(facts, longUrl);
    assert.ok(d);
    assert.ok(d.xCount <= X_LIMIT, String(d.xCount));
    assert.equal(d.xCount, xWeightedLength(d.x));
    assert.ok(d.x.startsWith(longUrl));
  });
  it("counts every link as 23 and non-Latin characters as 2", () => {
    assert.equal(xWeightedLength("hi"), 2);
    assert.equal(xWeightedLength("https://a.co/"), 23);
    assert.equal(xWeightedLength(`https://a.example/${"x".repeat(300)}`), 23);
    assert.equal(xWeightedLength("a\u65e5"), 3);
    assert.equal(xWeightedLength("x https://a.co/ y"), 2 + 23 + 2);
  });
});

describe("LLM patch tabs", () => {
  const llms = { path: "/llms.txt", kind: "llms.txt" as const, content: "# A\n" };
  const robots = { path: "/robots.txt (append)", kind: "robots.txt" as const, content: "User-agent: PerplexityBot\nAllow: /\n" };
  it("builds a tab per kind from real suggestedFiles and disables the rest with a reason", () => {
    const tabs = buildPatchTabs([auditOk({ suggestedFiles: [llms, robots] })]);
    assert.deepEqual(tabs.map((t) => [t.kind, t.files.length]), [["llms.txt", 1], ["json-ld", 0], ["robots.txt", 1]]);
    assert.match(tabs[1].reason ?? "", /did not suggest/);
    assert.equal(tabs[0].reason, undefined);
    assert.equal(tabs[0].files[0].from, "https://a.example/");
  });
  it("lists a file repeated across pages once", () => {
    const a = auditOk({ suggestedFiles: [llms] });
    const b = auditOk({ targetUrl: "https://a.example/b", suggestedFiles: [llms] });
    assert.equal(buildPatchTabs([a, b])[0].files.length, 1);
  });
  it("says to run the audit when none ran, and notes an existing llms.txt", () => {
    assert.match(buildPatchTabs([])[0].reason ?? "", /Run the site audit/);
    const present = auditOk({ aiReadiness: { llmsTxt: { present: true, url: "u" }, robotsTxt: { present: true, url: "x", aiBots: {} }, sitemap: { present: true } } });
    assert.match(buildPatchTabs([present])[0].reason ?? "", /already in place/);
  });
  it("ignores audits that did not read the page", () => {
    const bad = auditOk({ status: "unreachable", suggestedFiles: [llms] });
    assert.equal(buildPatchTabs([bad])[0].files.length, 0);
  });
});

describe("units", () => {
  it("states what each tool does without claims the code does not make", () => {
    assert.deepEqual(UNITS.map((u) => u.num), ["01", "02", "03", "04"]);
    assert.match(UNITS[1].blurb, /Needs your key file hosted on your site/);
    assert.doesNotMatch(UNITS.map((u) => u.blurb).join(" "), /Bing|Yandex|simultaneous|broadcast/i);
  });
  it("status word: READY only when included, enabled and not blocked", () => {
    const base = { enabled: true, included: true, blocked: false, phase: "idle" as ToolPhase };
    assert.equal(unitStatus(base).word, "READY");
    assert.equal(unitStatus({ ...base, included: false }).word, "OFF");
    assert.equal(unitStatus({ ...base, blocked: true }).word, "NEEDS INPUT");
    assert.equal(unitStatus({ ...base, enabled: false }).word, "SELF-HOST ONLY");
    assert.equal(unitStatus({ ...base, enabled: false, phase: "ready" }).word, "SELF-HOST ONLY");
    assert.equal(unitStatus({ ...base, phase: "running", progress: "1/3" }).word, "RUNNING 1/3");
    assert.deepEqual([unitStatus({ ...base, phase: "ready" }).word, unitStatus({ ...base, phase: "warning" }).word, unitStatus({ ...base, phase: "error" }).word], ["DONE", "ATTENTION", "FAILED"]);
  });
  it("totals and gaps count real results only", () => {
    assert.deepEqual(braveTotals([brave("accepted"), brave("timeout")]), { accepted: 1, other: 1, ms: 2000 });
    assert.equal(gapCount(auditOk()), 2);
    assert.equal(domainLabel([]), "");
    assert.equal(domainLabel(["a.example"]), "a.example");
    assert.equal(domainLabel(["a.example", "b.example"]), "2 hosts");
  });
});

describe("re-check prompt", () => {
  const ok: CloudflareBaseline = { status: "ok", message: "", zoneId: "zone123", windowEnd: "2026-10-27T00:00:00Z", totals: { requests: 10, bytes: 20 }, aiBots: [{ name: "GPTBot", requests: 3 }] };
  it("needs an ok baseline with a zone id", () => {
    assert.equal(buildRecheckPrompt(undefined), null);
    assert.equal(buildRecheckPrompt({ status: "error", message: "x" }), null);
    assert.equal(buildRecheckPrompt({ status: "ok", message: "" }), null);
  });
  it("embeds the baseline JSON verbatim", () => {
    const p = buildRecheckPrompt(ok) ?? "";
    assert.match(p, /snapshot-cloudflare-baseline/);
    assert.match(p, /zoneId "zone123"/);
    const json = p.slice(p.indexOf("```json\n") + 8, p.lastIndexOf("\n```"));
    assert.deepEqual(JSON.parse(json), ok);
  });
});

describe("suggested files bundle", () => {
  it("labels each file with its path", () => {
    assert.equal(suggestedFilesBundle([{ path: "/llms.txt", content: "# A\n" }, { path: "/robots.txt (append)", content: "User-agent: GPTBot" }]), "# /llms.txt\n# A\n\n# /robots.txt (append)\nUser-agent: GPTBot\n");
  });
});
