// Global budget ledger (held by the Durable Object on Workers). Fake clock; no I/O.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BudgetLedger, DEFAULT_LEDGER_CONFIG, emptyLedgerState, type LedgerConfig } from "../src/limits.js";

const T0 = Date.UTC(2026, 9, 29, 12, 0, 0);
const clock = (start = T0) => {
  const c = { t: start, now: () => c.t };
  return c;
};
const granted = (r: ReturnType<BudgetLedger["acquire"]>) => {
  assert.equal(r.ok, true, JSON.stringify(r));
  return (r as { leaseId: string }).leaseId;
};
const denied = (r: ReturnType<BudgetLedger["acquire"]>, code: string, text?: RegExp) => {
  assert.equal(r.ok, false, JSON.stringify(r));
  if (r.ok) return r;
  assert.equal(r.code, code);
  assert.ok(r.retryAfterSeconds >= 1);
  if (text) assert.match(r.message, text);
  return r;
};

describe("BudgetLedger: guard semantics", () => {
  it("brave: one at a time; the slot frees on release", () => {
    const c = clock();
    const l = new BudgetLedger(undefined, DEFAULT_LEDGER_CONFIG, c.now);
    const a = granted(l.acquire("brave", "https://a.example/"));
    denied(l.acquire("brave", "https://b.example/"), "busy", /already running/);
    l.release("brave", a, { sent: false, browserMs: 5000 });
    c.t += 21_000;
    granted(l.acquire("brave", "https://b.example/"));
  });

  it("brave: enforces the 20 s spacing between browser starts", () => {
    const c = clock();
    const l = new BudgetLedger(undefined, DEFAULT_LEDGER_CONFIG, c.now);
    l.release("brave", granted(l.acquire("brave", "https://a.example/")), { sent: false, browserMs: 1000 });
    c.t += 5_000;
    const d = denied(l.acquire("brave", "https://b.example/"), "busy", /every 20 seconds/);
    assert.equal(d.retryAfterSeconds, 15);
  });

  it("dedupes only requests that actually went out, for the configured time", () => {
    const c = clock();
    const l = new BudgetLedger(undefined, DEFAULT_LEDGER_CONFIG, c.now);
    l.release("brave", granted(l.acquire("brave", "https://x.example/")), { sent: false, browserMs: 1000 });
    c.t += 30_000;
    l.release("brave", granted(l.acquire("brave", "https://x.example/")), { sent: true, browserMs: 1000 });
    c.t += 30_000;
    denied(l.acquire("brave", "https://x.example/"), "recently_submitted", /already sent to Brave/);
    c.t += 24 * 3600_000;
    granted(l.acquire("brave", "https://x.example/"));
  });

  it("enforces the rolling hourly cap for all callers together", () => {
    const c = clock();
    const l = new BudgetLedger(undefined, DEFAULT_LEDGER_CONFIG, c.now);
    for (let i = 0; i < 6; i++) {
      l.release("viesearch", granted(l.acquire("viesearch", `k${i}`)), { sent: true, browserMs: 1000 });
      c.t += 30_000; // Viesearch uses the shared browser: one start per 25 s
    }
    const d = denied(l.acquire("viesearch", "k7"), "rate_limited", /6 Viesearch submissions per hour \(for all callers together\)/);
    assert.ok(d.retryAfterSeconds > 3400);
    c.t += 3600_000;
    granted(l.acquire("viesearch", "k7"));
  });

  it("audit: three at a time, no dedupe", () => {
    const l = new BudgetLedger(undefined, DEFAULT_LEDGER_CONFIG, clock().now);
    granted(l.acquire("audit", "same"));
    granted(l.acquire("audit", "same"));
    granted(l.acquire("audit", "same"));
    denied(l.acquire("audit", "same"), "busy", /site audit is already running/);
  });

  it("reclaims a lease whose request never reported back, and assumes it went out", () => {
    const c = clock();
    const l = new BudgetLedger(undefined, DEFAULT_LEDGER_CONFIG, c.now);
    granted(l.acquire("brave", "https://lost.example/"));
    c.t += 151_000;
    granted(l.acquire("brave", "https://other.example/"));
    assert.equal(l.state.browserMsUsed, DEFAULT_LEDGER_CONFIG.browserReserveMs);
    c.t += 200_000;
    denied(l.acquire("brave", "https://lost.example/"), "recently_submitted");
  });

  it("a late or duplicate release is harmless and does not double-charge", () => {
    const c = clock();
    const l = new BudgetLedger(undefined, DEFAULT_LEDGER_CONFIG, c.now);
    const id = granted(l.acquire("brave", "https://a.example/"));
    l.release("brave", id, { sent: true, browserMs: 10_000 });
    l.release("brave", id, { sent: true, browserMs: 10_000 });
    assert.equal(l.state.browserMsUsed, 10_000);
  });
});

describe("BudgetLedger: daily browser budget", () => {
  const cfg: LedgerConfig = { ...DEFAULT_LEDGER_CONFIG, kinds: { ...DEFAULT_LEDGER_CONFIG.kinds, brave: { ...DEFAULT_LEDGER_CONFIG.kinds.brave, maxPerWindow: 1000, dedupeMs: 0 } } };

  it("charges measured browser time and refuses before the daily budget would be exceeded", () => {
    const c = clock();
    const l = new BudgetLedger(undefined, cfg, c.now);
    // 8 min budget, 90 s reservation: after 6 x 60 s = 360 s used, 360 + 90 = 450 <= 480 is allowed; after 7 x 60 s it is not.
    for (let i = 0; i < 7; i++) {
      l.release("brave", granted(l.acquire("brave", `u${i}`)), { sent: true, browserMs: 60_000 });
      c.t += 21_000;
    }
    const d = denied(l.acquire("brave", "u8"), "rate_limited", /browser time on this server is used up .*8 of the hosting plan's 10 free browser minutes.*00:00 UTC.*Nothing was sent to Brave/);
    assert.equal(d.retryAfterSeconds, 12 * 3600 - 7 * 21);
  });

  it("charges the full reservation when the run time is unknown", () => {
    const l = new BudgetLedger(undefined, cfg, clock().now);
    l.release("brave", granted(l.acquire("brave", "u")), { sent: false });
    assert.equal(l.state.browserMsUsed, cfg.browserReserveMs);
  });

  it("counts in-flight reservations", () => {
    const c = clock();
    const tight: LedgerConfig = { ...cfg, dailyBrowserMs: 150_000, kinds: { ...cfg.kinds, brave: { ...cfg.kinds.brave, maxConcurrent: 3, minSpacingMs: 0 } } };
    const l = new BudgetLedger(undefined, tight, c.now);
    granted(l.acquire("brave", "a"));
    denied(l.acquire("brave", "b"), "rate_limited", /browser time/);
  });

  it("resets at 00:00 UTC and survives a JSON round-trip (Durable Object storage)", () => {
    const c = clock(Date.UTC(2026, 9, 29, 23, 59, 0));
    const l = new BudgetLedger(undefined, cfg, c.now);
    l.release("brave", granted(l.acquire("brave", "a")), { sent: true, browserMs: 450_000 });
    c.t += 21_000;
    denied(l.acquire("brave", "b"), "rate_limited");
    const restored = new BudgetLedger(JSON.parse(JSON.stringify(l.state)), cfg, c.now);
    c.t += 60_000;
    granted(restored.acquire("brave", "b"));
    assert.equal(restored.usage().day, "2026-10-30");
  });

  it("audit alone never touches the browser budget", () => {
    const l = new BudgetLedger(emptyLedgerState(T0), cfg, clock().now);
    l.release("audit", granted(l.acquire("audit", "x")), { sent: false, browserMs: 999_999 });
    assert.equal(l.state.browserMsUsed, 0);
  });
});
