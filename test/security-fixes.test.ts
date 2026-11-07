// Regression tests for the 2026-11-08 security review of the Viesearch commit.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BudgetLedger, DEFAULT_LEDGER_CONFIG, emptyLedgerState, type LedgerState } from "../src/limits.js";
import type { BrowserLike } from "../src/submit-core.js";
import { VIESEARCH_SUBMIT_URL } from "../src/viesearch.js";
import { submitViaViesearchRun } from "../src/worker/viesearch-browser-run.js";

/** A fake browser that records the first page.goto URL and then aborts the flow. */
function recordingBrowser(seen: string[]): BrowserLike {
  const page: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return undefined;
        if (prop === "goto") return async (u: string) => { seen.push(u); throw new Error("stop after goto"); };
        return () => page;
      },
    },
  );
  const browser: unknown = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return undefined;
        if (prop === "newPage") return async () => page;
        return async () => undefined;
      },
    },
  );
  return browser as BrowserLike;
}

describe("Viesearch never falls back to Brave's submit page", () => {
  it("the Worker runner navigates to viesearch.com when no test URL is given", async () => {
    const seen: string[] = [];
    await submitViaViesearchRun("https://example.com/", "someone@example.com", {} as never, {
      limits: async () => ({ allowedBrowserAcquisitions: 1, timeUntilNextAllowedBrowserAcquisition: 0 }),
      launch: async () => recordingBrowser(seen),
      timings: { totalBudgetMs: 3_000, navigationMs: 1_000, uiReadyMs: 500, minSettleMs: 0, observeMs: 500, challengePersistMs: 200, pollMs: 50 },
    });
    assert.equal(seen[0], VIESEARCH_SUBMIT_URL);
  });
});

describe("BudgetLedger: persisted state from an older build", () => {
  it("fills in a kind missing from saved state instead of throwing", () => {
    const now = Date.UTC(2026, 10, 8, 12);
    const old = emptyLedgerState(now) as unknown as { kinds: Record<string, unknown> };
    delete old.kinds.viesearch;
    old.kinds.indexnow = { starts: [], sent: [], leases: [] };
    const l = new BudgetLedger(old as unknown as LedgerState, DEFAULT_LEDGER_CONFIG, () => now);
    const r = l.acquire("viesearch", "https://example.com/");
    assert.equal(r.ok, true);
  });

  it("counts in-flight leases of every browser kind against the daily browser budget", () => {
    const now = Date.UTC(2026, 10, 8, 12);
    const r = DEFAULT_LEDGER_CONFIG.browserReserveMs;
    // Room for one reservation and a half: a second browser of ANY kind must not fit while one is in flight.
    const cfg = { ...DEFAULT_LEDGER_CONFIG, dailyBrowserMs: Math.floor(r * 1.5) };
    const l = new BudgetLedger(undefined, cfg, () => now);
    assert.equal(l.acquire("viesearch", "https://a.example/").ok, true);
    const brave = l.acquire("brave", "https://b.example/");
    assert.equal(brave.ok, false);
  });
});
