import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SubmissionGuard, bearerMatches, configFromEnv, dedupeKey, dedupeSetKey } from "../src/guard.js";

const cfg = { maxConcurrent: 1, maxPerWindow: 3, windowMs: 3_600_000, dedupeMs: 86_400_000 };

describe("SubmissionGuard", () => {
  it("allows one browser at a time and frees the slot on release", () => {
    const g = new SubmissionGuard(cfg);
    const a = g.tryAcquire("https://a.example/");
    assert.equal(a.ok, true);
    const b = g.tryAcquire("https://b.example/");
    assert.equal(b.ok === false && b.code, "busy");
    if (a.ok) a.release({ clicked: false });
    assert.equal(g.tryAcquire("https://b.example/").ok, true);
  });

  it("enforces a rolling per-window cap, counting attempts that never reached Brave", () => {
    let now = 0;
    const g = new SubmissionGuard(cfg, () => now);
    for (let i = 0; i < 3; i++) {
      const r = g.tryAcquire(`https://${i}.example/`);
      assert.equal(r.ok, true);
      if (r.ok) r.release({ clicked: false });
    }
    const denied = g.tryAcquire("https://4.example/");
    assert.equal(denied.ok === false && denied.code, "rate_limited");
    assert.ok(denied.ok === false && denied.retryAfterSeconds > 0);
    now += cfg.windowMs + 1;
    assert.equal(g.tryAcquire("https://4.example/").ok, true);
  });

  it("blocks re-submitting a URL that reached Brave, but not one that failed before clicking", () => {
    let now = 0;
    const g = new SubmissionGuard({ ...cfg, maxPerWindow: 10 }, () => now);
    const failed = g.tryAcquire("https://x.example/");
    if (failed.ok) failed.release({ clicked: false });
    const again = g.tryAcquire("https://x.example/");
    assert.equal(again.ok, true);
    if (again.ok) again.release({ clicked: true });
    const dup = g.tryAcquire("https://x.example/");
    assert.equal(dup.ok === false && dup.code, "recently_submitted");
    now += cfg.dedupeMs + 1;
    assert.equal(g.tryAcquire("https://x.example/").ok, true);
  });

  it("release is idempotent", () => {
    const g = new SubmissionGuard(cfg);
    const a = g.tryAcquire("https://a.example/");
    assert.ok(a.ok);
    a.release({ clicked: false });
    a.release({ clicked: false });
    assert.equal(g.tryAcquire("https://b.example/").ok, true);
    assert.equal(g.tryAcquire("https://c.example/").ok === false, true); // slot held by b, not double-freed
  });
});

describe("config and helpers", () => {
  it("clamps env values", () => {
    const c = configFromEnv({ BRAVE_SUBMITTER_MAX_CONCURRENT: "99", BRAVE_SUBMITTER_MAX_PER_HOUR: "0", BRAVE_SUBMITTER_DEDUPE_HOURS: "abc" });
    assert.equal(c.maxConcurrent, 3);
    assert.equal(c.maxPerWindow, 1);
    assert.equal(c.dedupeMs, 24 * 3_600_000);
    assert.equal(configFromEnv({}).maxConcurrent, 1);
  });

  it("dedupeKey ignores fragments and host case", () => {
    assert.equal(dedupeKey("https://Example.com/a#x"), dedupeKey("https://example.com/a"));
  });

  it("bearerMatches is exact and tolerant of header casing", () => {
    assert.equal(bearerMatches("Bearer secret", "secret"), true);
    assert.equal(bearerMatches("bearer secret", "secret"), true);
    assert.equal(bearerMatches("Bearer secre", "secret"), false);
    assert.equal(bearerMatches("secret", "secret"), false);
    assert.equal(bearerMatches(undefined, "secret"), false);
  });
});

describe("per-tool budgets (indexnow / audit-site)", () => {
  it("uses custom labels in denial messages and keeps the Brave wording by default", () => {
    const g = new SubmissionGuard({ ...cfg, maxConcurrent: 1 }, undefined, { target: "IndexNow", running: "IndexNow submission", unit: "IndexNow submissions" });
    const a = g.tryAcquire("k");
    assert.ok(a.ok);
    const busy = g.tryAcquire("k2");
    assert.ok(!busy.ok && /IndexNow submission/.test(busy.message) && !/Brave/.test(busy.message));
    a.release({ clicked: true });
    const dup = g.tryAcquire("k");
    assert.ok(!dup.ok && /IndexNow/.test(dup.message) && !/Brave/.test(dup.message));
    const d = new SubmissionGuard(cfg);
    const x = d.tryAcquire("a");
    assert.ok(x.ok);
    const denied = d.tryAcquire("b");
    assert.ok(!denied.ok && /browser submission/.test(denied.message));
  });

  it("an audit-style guard (3 concurrent, 40/hour, release without clicked) never dedupes", () => {
    const g = new SubmissionGuard({ maxConcurrent: 3, maxPerWindow: 40, windowMs: 3_600_000, dedupeMs: 3_600_000 });
    const grants = [1, 2, 3].map(() => g.tryAcquire("same"));
    assert.ok(grants.every((x) => x.ok));
    assert.equal(g.tryAcquire("same").ok, false); // 4th concurrent is busy
    for (const x of grants) if (x.ok) x.release({ clicked: false });
    assert.equal(g.tryAcquire("same").ok, true);
  });

  it("dedupeSetKey ignores URL order and duplicates, is case-insensitive on host, and differs per host or set", () => {
    const a = dedupeSetKey("Example.com", ["https://example.com/b", "https://example.com/a"]);
    assert.equal(a, dedupeSetKey("example.com", ["https://example.com/a", "https://example.com/b", "https://example.com/a"]));
    assert.notEqual(a, dedupeSetKey("example.com", ["https://example.com/a"]));
    assert.notEqual(a, dedupeSetKey("other.com", ["https://example.com/a", "https://example.com/b"]));
  });
});
