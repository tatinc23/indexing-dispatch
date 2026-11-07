// GLOBAL budget ledger used by the Cloudflare Workers deployment (held by ONE Durable Object, src/worker/limiter-do.ts).
// Pure and serializable: no I/O, injected clock, so the same rules are unit-tested on Node (test/limits.test.ts).
// Semantics match src/guard.ts (concurrency, rolling hourly cap, dedupe after a request actually went out) plus:
//   - leases: a slot held by a request that died is reclaimed after `leaseMs` (Workers can be evicted mid-request);
//   - minSpacingMs: Browser Run allows a new browser only every so often on the Free plan;
//   - a DAILY browser-time budget, so Cloudflare's free Browser Run minutes are never silently exhausted.
// The Node/Docker server keeps using the in-process SubmissionGuard (per process, not global).

export type BudgetKind = "brave" | "viesearch" | "audit";

export interface KindConfig {
  maxConcurrent: number;
  maxPerWindow: number;
  windowMs: number;
  /** A key whose request actually went out is not accepted again for this long (0 = no dedupe). */
  dedupeMs: number;
  /** Minimum gap between two starts (0 = none). */
  minSpacingMs: number;
  /** A held slot is reclaimed after this long even if release() never arrives. */
  leaseMs: number;
  /** Whether a start reserves browser time against the daily budget. */
  usesBrowser: boolean;
  labels: { target: string; running: string; unit: string };
}

export interface LedgerConfig {
  kinds: Record<BudgetKind, KindConfig>;
  /** Browser milliseconds this server may use per UTC day (below the platform allowance, as a safety margin). */
  dailyBrowserMs: number;
  /** Platform allowance, only used in messages. */
  platformDailyBrowserMs: number;
  /** Browser time reserved per run while it is in flight, and charged when the real duration is unknown. */
  browserReserveMs: number;
}

const HOUR = 60 * 60 * 1000;

// Free Browser Run (verified 2026-10-29, developers.cloudflare.com/browser-run/limits/): 10 min/day, 3 concurrent, 1 new browser per 20 s.
export const DEFAULT_LEDGER_CONFIG: LedgerConfig = {
  kinds: {
    brave: { maxConcurrent: 1, maxPerWindow: 12, windowMs: HOUR, dedupeMs: 24 * HOUR, minSpacingMs: 20_000, leaseMs: 150_000, usesBrowser: true, labels: { target: "Brave", running: "browser submission", unit: "submissions" } },
    viesearch: { maxConcurrent: 1, maxPerWindow: 6, windowMs: HOUR, dedupeMs: 24 * HOUR, minSpacingMs: 25_000, leaseMs: 150_000, usesBrowser: true, labels: { target: "Viesearch", running: "Viesearch submission", unit: "Viesearch submissions" } },
    audit: { maxConcurrent: 3, maxPerWindow: 40, windowMs: HOUR, dedupeMs: 0, minSpacingMs: 0, leaseMs: 90_000, usesBrowser: false, labels: { target: "the audit", running: "site audit", unit: "site audits" } },
  },
  dailyBrowserMs: 8 * 60_000,
  platformDailyBrowserMs: 10 * 60_000,
  browserReserveMs: 90_000,
};

export type LedgerDenied = { ok: false; code: "busy" | "rate_limited" | "recently_submitted"; message: string; retryAfterSeconds: number };
export type LedgerGranted = { ok: true; leaseId: string };

interface Lease {
  id: string;
  key: string;
  startedAt: number;
  expiresAt: number;
}
interface KindState {
  starts: number[];
  /** [key, at] pairs of requests that went out. */
  sent: [string, number][];
  leases: Lease[];
}
export interface LedgerState {
  /** UTC day (YYYY-MM-DD) that browserMsUsed belongs to. */
  day: string;
  browserMsUsed: number;
  kinds: Record<BudgetKind, KindState>;
  seq: number;
}

const emptyKind = (): KindState => ({ starts: [], sent: [], leases: [] });
export const emptyLedgerState = (now: number): LedgerState => ({ day: utcDay(now), browserMsUsed: 0, kinds: { brave: emptyKind(), viesearch: emptyKind(), audit: emptyKind() }, seq: 0 });

export function utcDay(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}
function msUntilNextUtcDay(t: number): number {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - t;
}
const secs = (ms: number) => Math.max(1, Math.ceil(ms / 1000));
const mins = (ms: number) => Math.round(ms / 60_000);

export class BudgetLedger {
  readonly state: LedgerState;

  constructor(
    state: LedgerState | undefined,
    private readonly config: LedgerConfig = DEFAULT_LEDGER_CONFIG,
    private readonly now: () => number = Date.now,
  ) {
    this.state = state ?? emptyLedgerState(this.now());
  }

  /** Drops expired windows/dedupe entries, reclaims dead leases and rolls the browser day. */
  private tidy(t: number): void {
    const day = utcDay(t);
    if (this.state.day !== day) {
      this.state.day = day;
      this.state.browserMsUsed = 0;
    }
    for (const kind of Object.keys(this.config.kinds) as BudgetKind[]) {
      const cfg = this.config.kinds[kind];
      // Saved state from an older build may lack a kind added since (e.g. viesearch): start it empty.
      const ks = (this.state.kinds[kind] ??= emptyKind());
      ks.starts = ks.starts.filter((s) => t - s < Math.max(cfg.windowMs, cfg.minSpacingMs));
      ks.sent = ks.sent.filter(([, at]) => t - at < cfg.dedupeMs);
      const dead = ks.leases.filter((l) => l.expiresAt <= t);
      ks.leases = ks.leases.filter((l) => l.expiresAt > t);
      // A request that never reported back: assume the worst (it may have gone out, and used its whole reservation).
      for (const l of dead) {
        if (cfg.dedupeMs > 0) ks.sent.push([l.key, l.startedAt]);
        if (cfg.usesBrowser) this.state.browserMsUsed += this.config.browserReserveMs;
      }
    }
  }

  acquire(kind: BudgetKind, key: string): LedgerGranted | LedgerDenied {
    const t = this.now();
    this.tidy(t);
    const cfg = this.config.kinds[kind];
    const ks = this.state.kinds[kind];

    const prior = ks.sent.find(([k]) => k === key);
    if (prior) {
      return {
        ok: false,
        code: "recently_submitted",
        message: `This was already sent to ${cfg.labels.target} by this server ${mins(t - prior[1])} minute(s) ago; it will not be sent again for ${Math.round(cfg.dedupeMs / HOUR)}h.`,
        retryAfterSeconds: secs(prior[1] + cfg.dedupeMs - t),
      };
    }
    if (ks.leases.length >= cfg.maxConcurrent) {
      return { ok: false, code: "busy", message: `A ${cfg.labels.running} is already running on this server. Wait before calling again; do not retry in a loop.`, retryAfterSeconds: 30 };
    }
    const inWindow = ks.starts.filter((s) => t - s < cfg.windowMs);
    if (inWindow.length >= cfg.maxPerWindow) {
      return { ok: false, code: "rate_limited", message: `This server allows ${cfg.maxPerWindow} ${cfg.labels.unit} per hour (for all callers together) and the limit is used up.`, retryAfterSeconds: secs(inWindow[0]! + cfg.windowMs - t) };
    }
    const last = ks.starts.length ? Math.max(...ks.starts) : undefined;
    if (cfg.minSpacingMs > 0 && last !== undefined && t - last < cfg.minSpacingMs) {
      return { ok: false, code: "busy", message: `The browser service allows a new browser only every ${Math.round(cfg.minSpacingMs / 1000)} seconds and one was just started.`, retryAfterSeconds: secs(last + cfg.minSpacingMs - t) };
    }
    if (cfg.usesBrowser) {
      const browserLeases = (Object.keys(this.config.kinds) as BudgetKind[])
        .filter((k) => this.config.kinds[k].usesBrowser)
        .reduce((n, k) => n + (this.state.kinds[k]?.leases.length ?? 0), 0);
      const inFlight = browserLeases * this.config.browserReserveMs;
      if (this.state.browserMsUsed + inFlight + this.config.browserReserveMs > this.config.dailyBrowserMs) {
        const resetIn = msUntilNextUtcDay(t);
        return {
          ok: false,
          code: "rate_limited",
          message: `Today's browser time on this server is used up (it keeps ${mins(this.config.dailyBrowserMs)} of the hosting plan's ${mins(this.config.platformDailyBrowserMs)} free browser minutes per day, and each submission reserves up to ${Math.round(this.config.browserReserveMs / 1000)} s). It resets at 00:00 UTC, in about ${mins(resetIn)} minute(s). Nothing was sent to Brave.`,
          retryAfterSeconds: secs(resetIn),
        };
      }
    }

    this.state.seq += 1;
    const leaseId = `${kind}-${t}-${this.state.seq}`;
    ks.leases.push({ id: leaseId, key, startedAt: t, expiresAt: t + cfg.leaseMs });
    ks.starts.push(t);
    return { ok: true, leaseId };
  }

  /** `sent`: the request reached the third party (a submitted browser form). `browserMs`: measured browser time, if any. */
  release(kind: BudgetKind, leaseId: string, outcome: { sent: boolean; browserMs?: number }): void {
    const t = this.now();
    const cfg = this.config.kinds[kind];
    const ks = this.state.kinds[kind];
    this.tidy(t); // may reclaim this lease if it already expired; tidy() then charged it in full
    const lease = ks.leases.find((l) => l.id === leaseId);
    if (!lease) return; // already reclaimed, or a duplicate release
    ks.leases = ks.leases.filter((l) => l.id !== leaseId);
    if (outcome.sent && cfg.dedupeMs > 0) {
      ks.sent.push([lease.key, t]);
      if (ks.sent.length > 1000) ks.sent.shift();
    }
    if (cfg.usesBrowser) {
      const measured = outcome.browserMs;
      // Charged to the current UTC day (conservative when a run spans midnight).
      this.state.browserMsUsed += typeof measured === "number" && Number.isFinite(measured) && measured >= 0 ? Math.ceil(measured) : this.config.browserReserveMs;
    }
  }

  /** Plain numbers for logs and the GET / info document. */
  usage(): { day: string; browserSecondsUsed: number; browserSecondsBudget: number } {
    this.tidy(this.now());
    return { day: this.state.day, browserSecondsUsed: Math.round(this.state.browserMsUsed / 1000), browserSecondsBudget: Math.round(this.config.dailyBrowserMs / 1000) };
  }
}
