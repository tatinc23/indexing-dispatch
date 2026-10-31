import { createHash, timingSafeEqual } from "node:crypto";

export interface GuardConfig {
  /** Browsers running at once. */
  maxConcurrent: number;
  /** Submissions started per rolling window. */
  maxPerWindow: number;
  windowMs: number;
  /** A URL that reached Brave is not submitted again for this long. */
  dedupeMs: number;
}

/** Wording for denial messages. Defaults keep the original Brave text. */
export interface GuardLabels {
  /** Who the work was sent to: "was already sent to <target>". */
  target: string;
  /** What is running: "A <running> is already running". */
  running: string;
  /** What the hourly limit counts. */
  unit: string;
}
const BRAVE_LABELS: GuardLabels = { target: "Brave", running: "browser submission", unit: "submissions" };

export type Denied = {
  ok: false;
  code: "busy" | "rate_limited" | "recently_submitted";
  message: string;
  retryAfterSeconds: number;
};
export type Granted = { ok: true; release: (outcome: { clicked: boolean }) => void };

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const envInt = (value: string | undefined, fallback: number) => {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
};

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): GuardConfig {
  return {
    maxConcurrent: clamp(envInt(env.BRAVE_SUBMITTER_MAX_CONCURRENT, 1), 1, 3),
    maxPerWindow: clamp(envInt(env.BRAVE_SUBMITTER_MAX_PER_HOUR, 12), 1, 60),
    windowMs: 60 * 60 * 1000,
    dedupeMs: clamp(envInt(env.BRAVE_SUBMITTER_DEDUPE_HOURS, 24), 1, 168) * 60 * 60 * 1000,
  };
}

/**
 * IN-PROCESS limits only. Each server instance counts independently and a restart or
 * scale-out resets them; this is not a global or distributed limit.
 */
export class SubmissionGuard {
  private active = 0;
  private starts: number[] = [];
  private submitted = new Map<string, number>();

  constructor(
    private readonly config: GuardConfig,
    private readonly now: () => number = Date.now,
    private readonly labels: GuardLabels = BRAVE_LABELS,
  ) {}

  tryAcquire(urlKey: string): Granted | Denied {
    const t = this.now();
    this.starts = this.starts.filter((s) => t - s < this.config.windowMs);
    for (const [key, at] of this.submitted) if (t - at >= this.config.dedupeMs) this.submitted.delete(key);

    const prior = this.submitted.get(urlKey);
    if (prior !== undefined) {
      return {
        ok: false,
        code: "recently_submitted",
        message: `This URL was already sent to ${this.labels.target} by this server instance ${Math.round((t - prior) / 60000)} minute(s) ago; it will not be submitted again for ${Math.round(this.config.dedupeMs / 3600000)}h.`,
        retryAfterSeconds: Math.max(1, Math.ceil((prior + this.config.dedupeMs - t) / 1000)),
      };
    }
    if (this.active >= this.config.maxConcurrent) {
      return {
        ok: false,
        code: "busy",
        message: `A ${this.labels.running} is already running on this server instance. Wait before calling again; do not retry in a loop.`,
        retryAfterSeconds: 30,
      };
    }
    if (this.starts.length >= this.config.maxPerWindow) {
      return {
        ok: false,
        code: "rate_limited",
        message: `This server instance allows ${this.config.maxPerWindow} ${this.labels.unit} per hour and the limit is used up.`,
        retryAfterSeconds: Math.max(1, Math.ceil((this.starts[0]! + this.config.windowMs - t) / 1000)),
      };
    }

    this.active++;
    this.starts.push(t);
    let released = false;
    return {
      ok: true,
      release: ({ clicked }) => {
        if (released) return;
        released = true;
        this.active--;
        if (clicked) {
          this.submitted.set(urlKey, this.now());
          if (this.submitted.size > 1000) this.submitted.delete(this.submitted.keys().next().value as string);
        }
      },
    };
  }
}

/** Dedupe key for a set of URLs on one host: order, duplicates and host case do not matter. */
export function dedupeSetKey(host: string, urls: string[]): string {
  const set = [...new Set(urls)].sort();
  return createHash("sha256").update(JSON.stringify([host.trim().toLowerCase(), set])).digest("hex");
}

/** Key used to detect repeat submissions: lowercase host, no fragment. */
export function dedupeKey(targetUrl: string): string {
  const u = new URL(targetUrl);
  u.hash = "";
  return u.href;
}

/** Constant-time bearer check; compares fixed-length digests so lengths never leak. */
export function bearerMatches(header: string | null | undefined, expectedKey: string): boolean {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  if (!match) return false;
  const a = createHash("sha256").update(match[1]!.trim()).digest();
  const b = createHash("sha256").update(expectedKey).digest();
  return timingSafeEqual(a, b);
}
