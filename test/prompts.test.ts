import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { auditSite } from "../src/audit.js";
import type { SafeFetchResult } from "../src/safe-fetch.js";
import {
  SERVER_INFO,
  auditSiteDef,
  checkMySitePromptText,
  submitBraveUrlDef,
  submitMySitePromptText,
  submitViesearchUrlDef,
} from "../src/tool-defs.js";

const bareFetch = async (url: string): Promise<SafeFetchResult> => ({
  ok: true,
  status: 200,
  finalUrl: url,
  headers: { "content-type": "text/html; charset=utf-8" },
  bodyText: "<html lang=\"en\"><head><title>T</title></head><body></body></html>",
  truncated: false,
});

describe("submit-my-site prompts", () => {
  it("submit-my-site with email covers audit, Brave and Viesearch with honest receipts and no retries", () => {
    const text = submitMySitePromptText("https://example.com/", "me@example.com");
    assert.match(text, /audit-site once/);
    assert.match(text, /submit-brave-url one time/);
    assert.match(text, /submit-viesearch-url one time/);
    assert.match(text, /word for word/);
    assert.match(text, /received, not indexed|doesn't mean the page is indexed or listed/);
    assert.match(text, /Don't retry|don't retry/i);
    assert.match(text, /Confirm Submission/);
    assert.match(text, /me@example\.com/);
  });

  it("submit-my-site without email skips the Viesearch step", () => {
    const text = submitMySitePromptText("https://example.com/");
    assert.match(text, /skip the Viesearch step/);
    assert.doesNotMatch(text, /submit-viesearch-url/);
    assert.match(text, /submit-brave-url one time/);
  });

  it("check-my-site is audit-only and read-only", () => {
    const text = checkMySitePromptText("example.com");
    assert.match(text, /audit-site once/);
    assert.doesNotMatch(text, /submit-brave-url/);
    assert.doesNotMatch(text, /submit-viesearch-url/);
    assert.match(text, /only reads/);
  });
});

describe("trigger phrases", () => {
  it("names the plain phrases in tool descriptions and server instructions", () => {
    assert.match(submitBraveUrlDef.description, /submit\/send\/add their site to Brave/);
    assert.match(submitViesearchUrlDef.description, /submit\/send\/add their site to Viesearch/);
    assert.match(auditSiteDef.description, /check\/audit their site/);
    assert.match(submitBraveUrlDef.description, /never guess/);
    assert.match(submitViesearchUrlDef.description, /never invent one/);
    assert.match(SERVER_INFO.instructions, /submit\/send\/add their site/);
    assert.match(SERVER_INFO.instructions, /ask for it and never guess/);
    assert.match(SERVER_INFO.instructions, /never invent one/);
  });

  it("keeps descriptions within platform length limits", () => {
    for (const d of [submitBraveUrlDef.description, submitViesearchUrlDef.description, auditSiteDef.description, SERVER_INFO.instructions]) {
      assert.ok(d.length <= 2000, `description too long: ${d.length}`);
    }
  });
});

describe("bare domains in audit-site", () => {
  it("normalizes a bare domain to https:// before fetching", async () => {
    const seen: string[] = [];
    const result = await auditSite(
      { targetUrl: "example.com" },
      {
        safeFetch: (async (url: string) => {
          seen.push(url);
          return bareFetch(url);
        }) as typeof bareFetch,
        now: () => 1000,
      },
    );
    assert.equal(result.targetUrl, "https://example.com");
    assert.ok(seen[0]?.startsWith("https://example.com"), seen[0]);
  });
});

import { plausibleEmail, renderSubmissionCanvasDef as _canvasDef } from "../src/tool-defs.js";
import { canvasPropsSchema as _props } from "../src/contract.js";
it("panel email prefill: shape check, optional input, carried in props", () => {
  assert.equal(plausibleEmail("emailme@tatinc.us"), true);
  assert.equal(plausibleEmail("  a@b.co  "), true);
  for (const bad of [undefined, "", "nope", "a@b", "a b@c.d", "x".repeat(250) + "@a.io"]) assert.equal(plausibleEmail(bad as string | undefined), false);
  assert.equal(_canvasDef.inputSchema.safeParse({ urls: ["https://a.com/"] }).success, true);
  assert.equal(_canvasDef.inputSchema.safeParse({ urls: ["https://a.com/"], email: "me@a.com" }).success, true);
  assert.equal(_props.safeParse({ initialUrls: [], mode: "interactive", enabledTools: { cloudflare: false, pageSpeed: false }, initialEmail: "me@a.com" }).success, true);
});
