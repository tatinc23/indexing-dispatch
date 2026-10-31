// ONE SQLite-backed Durable Object (name "global") holds every budget for the Workers deployment, so limits are
// global across isolates and locations. The rules live in src/limits.ts (pure, unit-tested); this class only loads and
// persists the ledger. Durable Objects run one request at a time, and storage writes are confirmed before the reply
// leaves (output gates), so acquire/release are atomic.
import { DurableObject } from "cloudflare:workers";
import { BudgetLedger, type BudgetKind, type LedgerDenied, type LedgerGranted, type LedgerState } from "../limits.js";

const KEY = "ledger";

export class BudgetLimiter extends DurableObject {
  private ledger: BudgetLedger = new BudgetLedger(undefined);

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    void ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get<LedgerState>(KEY);
      this.ledger = new BudgetLedger(saved ?? undefined);
    });
  }

  async acquire(kind: BudgetKind, key: string): Promise<LedgerGranted | LedgerDenied> {
    const r = this.ledger.acquire(kind, key);
    await this.ctx.storage.put(KEY, this.ledger.state);
    return r;
  }

  async release(kind: BudgetKind, leaseId: string, outcome: { sent: boolean; browserMs?: number }): Promise<void> {
    this.ledger.release(kind, leaseId, outcome);
    await this.ctx.storage.put(KEY, this.ledger.state);
  }

  async usage(): Promise<{ day: string; browserSecondsUsed: number; browserSecondsBudget: number }> {
    return this.ledger.usage();
  }
}
