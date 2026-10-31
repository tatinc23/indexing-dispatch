import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_URL_LENGTH, inputSchema } from "../src/schema.js";

const ok = (u: string) => inputSchema.safeParse({ targetUrl: u });

describe("targetUrl validation", () => {
  it("accepts public http and https URLs and trims whitespace", () => {
    for (const u of ["https://tatinc.us", "http://example.com/path?q=1#frag", "https://sub.example.co.uk:8443/a"]) {
      assert.equal(ok(u).success, true, u);
    }
    const parsed = ok("  https://tatinc.us  ");
    assert.equal(parsed.success && parsed.data.targetUrl, "https://tatinc.us");
  });

  it("rejects non-absolute, non-http(s) and malformed values", () => {
    for (const u of ["", "tatinc.us", "/relative", "ftp://example.com", "javascript:alert(1)", "file:///etc/passwd", "data:text/html,hi", "https://", "https://exa mple.com", "not a url"]) {
      assert.equal(ok(u).success, false, u);
    }
  });

  it("rejects embedded credentials", () => {
    for (const u of ["https://user:pass@example.com", "https://user@example.com", "http://:pw@example.com"]) {
      const r = ok(u);
      assert.equal(r.success, false, u);
    }
  });

  it("rejects over-long URLs", () => {
    const long = `https://example.com/${"a".repeat(MAX_URL_LENGTH)}`;
    assert.equal(ok(long).success, false);
    assert.equal(ok(`https://example.com/${"a".repeat(MAX_URL_LENGTH - 30)}`).success, true);
  });

  it("rejects hosts Brave could never crawl", () => {
    for (const u of [
      "http://localhost:3000",
      "http://foo.localhost",
      "http://intranet",
      "http://printer.local",
      "http://127.0.0.1",
      "http://10.1.2.3",
      "http://192.168.0.5",
      "http://172.20.0.1",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]/",
      "http://[fd00::1]/",
    ]) {
      assert.equal(ok(u).success, false, u);
    }
    assert.equal(ok("http://8.8.8.8/").success, true);
  });

  it("reports a readable message", () => {
    const r = ok("https://user:pass@example.com");
    assert.equal(r.success, false);
    assert.match(JSON.stringify(r.error?.issues), /embedded username or password/);
  });

  it("drops any extra keys, so a client cannot smuggle in a destination", () => {
    const r = inputSchema.parse({ targetUrl: "https://tatinc.us", submitPageUrl: "https://evil.example", url: "https://evil.example" });
    assert.deepEqual(Object.keys(r), ["targetUrl"]);
  });
});
