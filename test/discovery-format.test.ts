import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AuditResult, CloudflareBaseline, IndexNowResult } from "../src/contract.js";
import { auditToolResult, cloudflareToolResult, indexNowToolResult } from "../src/discovery-format.js";

describe("discovery tool results", () => {
  it("indexnow: text carries status and message; isError unless submitted", () => {
    const base: IndexNowResult = { status: "submitted", host: "example.com", urlCount: 2, keyLocation: "https://example.com/k.txt", keyVerified: true, engines: [], message: "IndexNow accepted the request.", durationMs: 12 };
    const ok = indexNowToolResult(base);
    assert.equal(ok.structuredContent, base);
    assert.match(ok.content[0]!.text, /SUBMITTED/);
    assert.match(ok.content[0]!.text, /IndexNow accepted/);
    assert.equal("isError" in ok, false);
    assert.equal(indexNowToolResult({ ...base, status: "key_not_verified" }).isError, true);
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
