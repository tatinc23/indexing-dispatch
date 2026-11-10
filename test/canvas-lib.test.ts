import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AuditResult, CloudflareBaseline } from "../src/contract.js";
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
  emailProblem,
  gapCount,
  initialUrlText,
  normalizeProps,
  parseUrlList,
  planViesearch,
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
  it("passes through morePlacesUrl when present, absent otherwise", () => {
    assert.equal(normalizeProps({ morePlacesUrl: "https://dispatch.tatinc.us/more-places" }).morePlacesUrl, "https://dispatch.tatinc.us/more-places");
    assert.equal(normalizeProps({}).morePlacesUrl, undefined);
    assert.equal(normalizeProps({ morePlacesUrl: 42 }).morePlacesUrl, undefined);
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

describe("Viesearch plan", () => {
  const email = "me@example.com";
  it("requires an email and never invents one", () => {
    assert.equal(planViesearch(["https://a.example/"], "").ok, false);
    assert.match(emailProblem("") ?? "", /Enter your email address/);
    assert.match(emailProblem("not-an-email") ?? "", /does not look complete/);
    assert.match(emailProblem("a@b c.com") ?? "", /does not look complete/);
    assert.equal(emailProblem("  me@example.com  ".trim()), null);
  });
  it("passes the email and every URL through untouched", () => {
    const ok = planViesearch(["https://a.example/x", "https://b.example/y"], email);
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.args, { urls: ["https://a.example/x", "https://b.example/y"], email });
  });
  it("needs at least one URL", () => {
    const p = planViesearch([], email);
    assert.equal(p.ok, false);
    assert.match(p.problem ?? "", /at least one URL/);
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
  it("viesearch rows reuse the Brave outcome phase", () => {
    assert.equal(bravePhase([]), "idle");
    assert.equal(bravePhase([brave("accepted")]), "ready");
    assert.equal(bravePhase([brave("accepted"), brave("rejected")]), "warning");
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
describe("social drafts", () => {
  it("is null without an observed result for that URL", () => {
    assert.equal(buildSocialDrafts({ brave: [], viesearch: [], audits: [] }, "https://a.example/"), null);
    assert.equal(buildSocialDrafts({ brave: [brave("accepted", "https://b.example/")], viesearch: [], audits: [] }, "https://a.example/"), null);
    assert.deepEqual(urlsWithFacts({ brave: [brave("accepted", "https://b.example/")], viesearch: [], audits: [auditOk()] }), ["https://b.example/", "https://a.example/"]);
  });
  it("reports non-accepted Brave outcomes as what they were", () => {
    const d = buildSocialDrafts({ brave: [brave("timeout", "https://a.example/")], viesearch: [], audits: [] }, "https://a.example/");
    assert.ok(d);
    assert.match(d.x, /Brave Search submit form: gave no answer before the time limit\./);
    assert.doesNotMatch(d.x, /accepted/);
    const r = buildSocialDrafts({ brave: [brave("rejected", "https://a.example/")], viesearch: [], audits: [] }, "https://a.example/");
    assert.match(r?.x ?? "", /rejected\./);
  });
  it("reports Viesearch outcomes per URL and ignores other URLs' rows", () => {
    const v = (status: "accepted" | "rejected", url = "https://a.example/"): SubmitResult => ({ targetUrl: url, status, message: "m", durationMs: 1000 });
    const d = buildSocialDrafts({ brave: [], viesearch: [v("accepted"), v("rejected", "https://a.example/other")], audits: [] }, "https://a.example/");
    assert.ok(d);
    assert.match(d.x, /Viesearch submit form: accepted it\./);
    assert.doesNotMatch(d.x, /rejected it/);
    const r = buildSocialDrafts({ brave: [], viesearch: [v("rejected")], audits: [] }, "https://a.example/");
    assert.match(r?.x ?? "", /Viesearch submit form: rejected it\./);
  });
  it("uses only observed facts and never claims indexing, ranking or going live", () => {
    const facts = { brave: [brave("accepted", "https://a.example/")], viesearch: [{ targetUrl: "https://a.example/", status: "accepted", message: "m", durationMs: 1000 } as SubmitResult], audits: [auditOk()] };
    const d = buildSocialDrafts(facts, "https://a.example/");
    assert.ok(d);
    const all = `${d.x}\n${d.linkedin}`;
    assert.match(d.x, /^https:\/\/a\.example\/\nBrave Search submit form: accepted\./);
    assert.match(d.x, /Viesearch submit form: accepted it\./);
    assert.match(d.x, /Audit: llms\.txt not found, 2 gaps flagged\./);
    assert.match(d.linkedin, /Checked Example \(https:\/\/a\.example\/\)\./);
    assert.match(d.linkedin, /HTTP 200; llms\.txt not found; sitemap not found; JSON-LD: Organization; 2 gaps flagged/);
    assert.doesNotMatch(all, /\b(live|indexed|ranking|ranked|officially|deployed|free|receipts?|visitors?|PageSpeed)\b/i);
  });
  it("leaves out Viesearch rows that belong to a different URL", () => {
    const d1 = buildSocialDrafts({ brave: [brave("accepted", "https://a.example/")], viesearch: [{ targetUrl: "https://a.example/other", status: "accepted", message: "m", durationMs: 1 } as SubmitResult], audits: [] }, "https://a.example/");
    assert.doesNotMatch(d1?.x ?? "", /Viesearch/);
  });
  it("includes PageSpeed only when a real score exists, and only in the LinkedIn draft", () => {
    const withPs = auditOk({ pageSpeed: { status: "ok", strategy: "mobile", performanceScore: 91 } });
    const d = buildSocialDrafts({ brave: [], viesearch: [], audits: [withPs] }, "https://a.example/");
    assert.match(d?.linkedin ?? "", /PageSpeed performance 91 \(mobile\)/);
    assert.doesNotMatch(d?.x ?? "", /PageSpeed/);
    const skipped = buildSocialDrafts({ brave: [], viesearch: [], audits: [auditOk({ pageSpeed: { status: "skipped", reason: "no key" } })] }, "https://a.example/");
    assert.doesNotMatch(skipped?.linkedin ?? "", /PageSpeed/);
  });
  it("keeps the X draft within 280 and reports a matching count", () => {
    const longUrl = `https://a.example/${"p".repeat(400)}`;
    const facts = { brave: [brave("accepted", longUrl)], viesearch: [{ targetUrl: longUrl, status: "accepted", message: "m", durationMs: 1 } as SubmitResult], audits: [auditOk({ targetUrl: longUrl })] };
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
    assert.match(UNITS[1].blurb, /Viesearch.*URL and email/);
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

import { parseUrlList as _parse } from "../views/render-submission-canvas/lib.js";
it("panel accepts bare domains like the server does", () => {
  assert.deepEqual(_parse("jordy.tatinc.us").urls, ["https://jordy.tatinc.us"]);
  assert.deepEqual(_parse("a.com:8080/x").urls, ["https://a.com:8080/x"]);
  assert.equal(_parse("javascript:alert(1)").urls.length, 0);
  assert.equal(_parse("localhost").urls.length, 0);
});
