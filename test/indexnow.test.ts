import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SafeFetchResult } from "../src/safe-fetch.js";
import { submitIndexNow, type IndexNowDeps } from "../src/indexnow.js";

const KEY = "abcd1234efgh5678";
const HOST = "example.com";

const keyOk = (body = KEY): SafeFetchResult => ({ ok: true, status: 200, finalUrl: `https://${HOST}/${KEY}.txt`, headers: {}, bodyText: body, truncated: false });

interface Calls {
  safe: string[];
  posts: { url: string; init: RequestInit }[];
}
function deps(opts: { key?: SafeFetchResult; post?: () => Response | Promise<Response> } = {}): { d: IndexNowDeps; calls: Calls } {
  const calls: Calls = { safe: [], posts: [] };
  const d: IndexNowDeps = {
    safeFetch: async (url) => {
      calls.safe.push(url);
      return opts.key ?? keyOk();
    },
    fetch: async (url, init) => {
      calls.posts.push({ url: String(url), init: init ?? {} });
      return (opts.post ?? (() => new Response("", { status: 200 })))();
    },
    now: () => 1000,
  };
  return { d, calls };
}
const input = (over: Partial<Parameters<typeof submitIndexNow>[0]> = {}) => ({ host: HOST, key: KEY, urls: [`https://${HOST}/a`], ...over });

describe("submitIndexNow input validation (no network)", () => {
  for (const bad of ["short", "has space 12345", "under_score_12345", "a".repeat(129), "", "ключ-ключ-ключ-ключ"]) {
    it(`rejects key ${JSON.stringify(bad.slice(0, 20))}`, async () => {
      const { d, calls } = deps();
      const r = await submitIndexNow(input({ key: bad }), d);
      assert.equal(r.status, "error");
      assert.match(r.message, /key/i);
      assert.equal(calls.safe.length + calls.posts.length, 0);
    });
  }

  it("rejects more than 100 URLs and zero URLs", async () => {
    const { d, calls } = deps();
    const many = Array.from({ length: 101 }, (_, i) => `https://${HOST}/p${i}`);
    assert.equal((await submitIndexNow(input({ urls: many }), d)).status, "error");
    assert.equal((await submitIndexNow(input({ urls: [] }), d)).status, "error");
    assert.equal(calls.safe.length + calls.posts.length, 0);
  });

  it("accepts exactly 100 URLs", async () => {
    const { d } = deps();
    const urls = Array.from({ length: 100 }, (_, i) => `https://${HOST}/p${i}`);
    assert.equal((await submitIndexNow(input({ urls }), d)).status, "submitted");
  });

  it("rejects URLs on another host, other schemes, subdomains and credentials", async () => {
    for (const u of ["https://other.com/a", "https://www.example.com/a", "ftp://example.com/a", "javascript:alert(1)", "https://user:pw@example.com/a", "not a url", "https://example.com.evil.com/"]) {
      const { d, calls } = deps();
      const r = await submitIndexNow(input({ urls: [`https://${HOST}/ok`, u] }), d);
      assert.equal(r.status, "error", u);
      assert.match(r.message, /host|http|URL/i, u);
      assert.equal(calls.safe.length + calls.posts.length, 0, u);
    }
  });

  it("treats the host case-insensitively and mixes http and https", async () => {
    const { d, calls } = deps({ key: keyOk() });
    const r = await submitIndexNow(input({ host: "Example.COM", urls: ["http://EXAMPLE.com/a", "https://example.com/b"] }), d);
    assert.equal(r.status, "submitted");
    assert.equal(r.host, "example.com");
    assert.equal(JSON.parse(String(calls.posts[0]!.init.body)).host, "example.com");
  });

  it("rejects a host that is not a bare hostname", async () => {
    for (const h of ["https://example.com", "example.com/path", "example.com:8080", "127.0.0.1", "", "exa mple.com"]) {
      const { d, calls } = deps();
      const r = await submitIndexNow(input({ host: h, urls: [`https://${HOST}/a`] }), d);
      assert.equal(r.status, "error", h);
      assert.equal(calls.safe.length + calls.posts.length, 0, h);
    }
  });

  it("rejects a keyLocation on another host and URLs outside the key file's folder", async () => {
    const a = deps();
    const r1 = await submitIndexNow(input({ keyLocation: `https://evil.com/${KEY}.txt` }), a.d);
    assert.equal(r1.status, "error");
    assert.equal(a.calls.safe.length, 0);
    const b = deps();
    const r2 = await submitIndexNow(input({ keyLocation: `https://${HOST}/catalog/${KEY}.txt`, urls: [`https://${HOST}/help/x`] }), b.d);
    assert.equal(r2.status, "error");
    assert.match(r2.message, /key file|folder|path/i);
    assert.equal(b.calls.safe.length, 0);
  });
});

describe("submitIndexNow key verification", () => {
  it("fetches the default key location via safeFetch before pinging", async () => {
    const { d, calls } = deps();
    const r = await submitIndexNow(input(), d);
    assert.deepEqual(calls.safe, [`https://${HOST}/${KEY}.txt`]);
    assert.equal(r.keyLocation, `https://${HOST}/${KEY}.txt`);
    assert.equal(r.keyVerified, true);
  });

  it("accepts a trailing newline but not extra text, and does not ping on mismatch", async () => {
    const ok = deps({ key: keyOk(`${KEY}\n`) });
    assert.equal((await submitIndexNow(input(), ok.d)).status, "submitted");
    for (const body of ["", "other", `${KEY} extra`, `<html>${KEY}</html>`]) {
      const { d, calls } = deps({ key: keyOk(body) });
      const r = await submitIndexNow(input(), d);
      assert.equal(r.status, "key_not_verified", body);
      assert.equal(r.keyVerified, false);
      assert.equal(calls.posts.length, 0, body);
    }
  });

  it("does not ping when the key file is missing (404) or unreachable", async () => {
    for (const key of [
      { ok: false, status: 404, finalUrl: "", headers: {}, bodyText: "nope", truncated: false },
      { ok: false, status: 0, finalUrl: "", headers: {}, bodyText: "", truncated: false, error: "timeout" },
    ] as SafeFetchResult[]) {
      const { d, calls } = deps({ key });
      const r = await submitIndexNow(input(), d);
      assert.equal(r.status, "key_not_verified");
      assert.equal(calls.posts.length, 0);
    }
  });

  it("does not trust a truncated key file body", async () => {
    const { d, calls } = deps({ key: { ...keyOk(), truncated: true } });
    assert.equal((await submitIndexNow(input(), d)).status, "key_not_verified");
    assert.equal(calls.posts.length, 0);
  });

  it("reports blocked (SSRF guard) and never pings", async () => {
    const { d, calls } = deps({ key: { ok: false, status: 0, finalUrl: "", headers: {}, bodyText: "", truncated: false, blockedReason: "private 10.0.0.0/8" } });
    const r = await submitIndexNow(input(), d);
    assert.equal(r.status, "blocked");
    assert.match(r.message, /10\.0\.0\.0/);
    assert.equal(calls.posts.length, 0);
  });

  it("restricts the key fetch to the key location's origin", async () => {
    const seen: unknown[] = [];
    const { d } = deps();
    d.safeFetch = async (_u, opts) => {
      seen.push(opts);
      return keyOk();
    };
    await submitIndexNow(input(), d);
    assert.deepEqual(seen, [{ allowedOrigin: `https://${HOST}` }]);
  });
});

describe("submitIndexNow ping", () => {
  it("sends ONE POST with the documented JSON body to api.indexnow.org", async () => {
    const { d, calls } = deps();
    const urls = [`https://${HOST}/a`, `https://${HOST}/b`];
    const r = await submitIndexNow(input({ urls }), d);
    assert.equal(calls.posts.length, 1);
    const p = calls.posts[0]!;
    assert.equal(p.url, "https://api.indexnow.org/indexnow");
    assert.equal(p.init.method, "POST");
    assert.match(String((p.init.headers as Record<string, string>)["content-type"]), /^application\/json; charset=utf-8$/i);
    assert.deepEqual(JSON.parse(String(p.init.body)), { host: HOST, key: KEY, keyLocation: `https://${HOST}/${KEY}.txt`, urlList: urls });
    assert.equal(p.init.redirect, "manual");
    assert.equal(r.urlCount, 2);
    assert.equal(r.engines.length, 1);
    assert.equal(r.engines[0]!.engine, "api.indexnow.org");
    assert.equal(r.engines[0]!.endpoint, "https://api.indexnow.org/indexnow");
    assert.equal(r.engines[0]!.httpStatus, 200);
    assert.equal(r.engines[0]!.ok, true);
  });

  it("de-duplicates identical URLs in the list", async () => {
    const { d, calls } = deps();
    const r = await submitIndexNow(input({ urls: [`https://${HOST}/a`, `https://${HOST}/a`] }), d);
    assert.equal(r.urlCount, 1);
    assert.equal(JSON.parse(String(calls.posts[0]!.init.body)).urlList.length, 1);
  });

  it("maps 200 and 202 to submitted and says acceptance is not indexing", async () => {
    for (const status of [200, 202]) {
      const { d } = deps({ post: () => new Response("", { status }) });
      const r = await submitIndexNow(input(), d);
      assert.equal(r.status, "submitted", String(status));
      assert.match(r.message, /not .*index/i);
      if (status === 202) assert.match(r.message, /pending/i);
    }
  });

  it("maps 403 and 422 to rejected with their documented meanings", async () => {
    const forbidden = await submitIndexNow(input(), deps({ post: () => new Response("", { status: 403 }) }).d);
    assert.equal(forbidden.status, "rejected");
    assert.match(forbidden.message, /key/i);
    assert.equal(forbidden.engines[0]!.ok, false);
    const unproc = await submitIndexNow(input(), deps({ post: () => new Response("", { status: 422 }) }).d);
    assert.equal(unproc.status, "rejected");
    assert.match(unproc.message, /host|schema|repeat/i);
    const bad = await submitIndexNow(input(), deps({ post: () => new Response("", { status: 400 }) }).d);
    assert.equal(bad.status, "rejected");
  });

  it("maps 429 to rejected with Retry-After and the 10 minute rule, without retrying", async () => {
    const { d, calls } = deps({ post: () => new Response("", { status: 429, headers: { "retry-after": "120" } }) });
    const r = await submitIndexNow(input(), d);
    assert.equal(r.status, "rejected");
    assert.match(r.message, /Retry-After/i);
    assert.match(r.message, /120/);
    assert.match(r.message, /10 minutes/);
    assert.equal(calls.posts.length, 1);
  });

  it("ignores a junk Retry-After value", async () => {
    const { d } = deps({ post: () => new Response("", { status: 429, headers: { "retry-after": "<script>alert(1)</script>" } }) });
    const r = await submitIndexNow(input(), d);
    assert.doesNotMatch(r.message, /script/);
  });

  it("maps a network error to error (single attempt)", async () => {
    const { d, calls } = deps({
      post: () => {
        throw new Error("socket hang up");
      },
    });
    const r = await submitIndexNow(input(), d);
    assert.equal(r.status, "error");
    assert.equal(r.keyVerified, true);
    assert.match(r.message, /socket hang up/);
    assert.equal(calls.posts.length, 1);
  });

  it("maps 5xx and unexpected redirects to error, not rejected", async () => {
    for (const status of [500, 503, 302]) {
      const { d } = deps({ post: () => new Response("", { status }) });
      assert.equal((await submitIndexNow(input(), d)).status, "error", String(status));
    }
  });

  it("reports duration from the injected clock", async () => {
    let t = 0;
    const { d } = deps();
    d.now = () => (t += 50);
    assert.equal((await submitIndexNow(input(), d)).durationMs, 50);
  });
});
