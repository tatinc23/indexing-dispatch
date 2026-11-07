import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AuditResult, CloudflareBaseline, ViesearchResult } from "../src/contract.js";
import { auditToolResult, cloudflareToolResult, viesearchToolResult } from "../src/discovery-format.js";

describe("discovery tool results", () => {
  it("viesearch: text carries status and message with a more-places line; isError unless accepted", () => {
    const base: ViesearchResult = { targetUrl: "https://example.com/", status: "accepted", message: "Viesearch confirmed.", confirmationText: "Thank you!", durationMs: 1200 };
    const ok = viesearchToolResult(base);
    assert.equal(ok.structuredContent, base);
    assert.match(ok.content[0]!.text, /ACCEPTED/);
    assert.match(ok.content[0]!.text, /Viesearch confirmed/);
    assert.match(ok.content[0]!.text, /Viesearch said: "Thank you!"/);
    assert.match(ok.content[0]!.text, /More places to submit yourself: https:\/\/dispatch\.tatinc\.us\/more-places/);
    assert.equal("isError" in ok, false);
    assert.equal(viesearchToolResult({ ...base, status: "rejected", confirmationText: undefined }).isError, true);
  });

  it("audit: lists findings and suggested file paths, and the PageSpeed state", () => {
    const r: AuditResult = {
      status: "ok", targetUrl: "https://example.com/", message: "Fetched.",
      findings: [{ id: "llms-txt-missing", severity: "missing", message: "No llms.txt." }],
      suggestedFiles: [{ path: "/llms.txt", kind: "llms.txt", content: "# x" }],
      pageSpeed: { status: "skipped", reason: "PAGESPEED_API_KEY not set" },
      durationMs: 5,
    };
    const t = auditToolResult(r);
    assert.match(t.content[0]!.text, /\[missing\] No llms\.txt\./);
    assert.match(t.content[0]!.text, /\/llms\.txt/);
    assert.match(t.content[0]!.text, /PageSpeed.*skipped.*PAGESPEED_API_KEY not set/);
    assert.equal("isError" in t, false);
    assert.equal(auditToolResult({ ...r, status: "blocked" }).isError, true);
  });

  it("cloudflare: shows totals and AI bots only when present", () => {
    const r: CloudflareBaseline = { status: "ok", message: "Read.", totals: { requests: 10, bytes: 20 }, aiBots: [{ name: "GPTBot", requests: 3 }] };
    const t = cloudflareToolResult(r);
    assert.match(t.content[0]!.text, /requests: 10/);
    assert.match(t.content[0]!.text, /GPTBot: 3/);
    assert.equal(cloudflareToolResult({ status: "error", message: "bad" }).isError, true);
    assert.doesNotMatch(cloudflareToolResult({ status: "error", message: "bad" }).content[0]!.text, /requests:/);
  });
});
