// snapshot-cloudflare-baseline engine. Reads the operator's own Cloudflare zone through the GraphQL Analytics API
// (queries from docs/engines-2026-10-27.md section 3.4). The token comes ONLY from env CF_ANALYTICS_API_TOKEN: it is
// not a tool argument and is redacted from every message. Numbers are exactly what Cloudflare returned; when a query
// fails we say so instead of filling gaps.
import type { CloudflareBaseline } from "./contract.js";

export const CF_GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";
const DAY_MS = 86_400_000;
const DEFAULT_LOOKBACK_DAYS = 7;
const MAX_LOOKBACK_DAYS = 30;
const TIMEOUT_MS = 15_000;
const BOT_GROUP_LIMIT = 500;
const ZONE_PATTERN = /^[0-9a-f]{32}$/i;

/** Zones this operator allows callers to read: comma/space separated 32-hex ids in CF_ZONE_IDS. Empty means the tool is not offered. */
export function parseAllowedZones(raw: string | undefined): Set<string> {
  const ids = (raw ?? "").split(/[\s,]+/).map((z) => z.trim().toLowerCase()).filter((z) => ZONE_PATTERN.test(z));
  return new Set(ids);
}

/** A token can usually read every zone on the operator's account, so callers may only ask about zones the operator listed. */
export function zoneAllowed(zoneId: string, allowed: Set<string>): boolean {
  return allowed.has(zoneId.trim().toLowerCase());
}

/** Crawler tokens that fetch for AI products, from docs/engines-2026-10-27.md section 4. Google-Extended is excluded: it has no UA string. */
export const AI_BOT_TOKENS = ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-User", "Claude-SearchBot", "PerplexityBot", "Perplexity-User"] as const;

const DAILY_QUERY = `query ($zoneTag: string, $from: Date, $to: Date) {
  viewer { zones(filter: { zoneTag: $zoneTag }) {
    httpRequests1dGroups(limit: 31, filter: { date_geq: $from, date_leq: $to }, orderBy: [date_ASC]) {
      dimensions { date }
      sum { requests bytes }
      uniq { uniques }
    }
  } }
}`;

const BOT_QUERY = `query ($zoneTag: string, $from: Time, $to: Time) {
  viewer { zones(filter: { zoneTag: $zoneTag }) {
    httpRequestsAdaptiveGroups(
      limit: ${BOT_GROUP_LIMIT}, orderBy: [count_DESC],
      filter: { datetime_geq: $from, datetime_lt: $to, requestSource: "eyeball", OR: [${AI_BOT_TOKENS.map((t) => `{ userAgent_like: "%${t}%" }`).join(", ")}] }
    ) {
      count
      dimensions { userAgent }
    }
  } }
}`;

export interface CloudflareInput {
  zoneId: string;
  lookbackDays?: number;
  previous?: CloudflareBaseline;
}

export interface CloudflareDeps {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  env?: Record<string, string | undefined>;
  now?: () => number;
}

type Outcome<T> = { ok: true; value: T } | { ok: false; message: string };

export async function snapshotCloudflareBaseline(input: CloudflareInput, deps: CloudflareDeps = {}): Promise<CloudflareBaseline> {
  const env = deps.env ?? process.env;
  const post = deps.fetch ?? ((url, init) => fetch(url, init));
  const now = (deps.now ?? Date.now)();

  const token = env.CF_ANALYTICS_API_TOKEN?.trim();
  if (!token) {
    return { status: "not_configured", message: "CF_ANALYTICS_API_TOKEN is not set on this server, so no Cloudflare data can be read. The operator sets it (Zone > Analytics > Read, scoped to one zone); it is never accepted as a tool argument." };
  }
  const zoneId = typeof input.zoneId === "string" ? input.zoneId.trim().toLowerCase() : "";
  if (!ZONE_PATTERN.test(zoneId)) return { status: "error", message: "zoneId must be the 32-character hexadecimal Cloudflare zone id (Overview page, right column)." };

  const requested = Number.isFinite(input.lookbackDays) ? Math.floor(input.lookbackDays as number) : DEFAULT_LOOKBACK_DAYS;
  const lookbackDays = Math.min(MAX_LOOKBACK_DAYS, Math.max(1, requested));
  const windowStart = new Date(now - lookbackDays * DAY_MS).toISOString();
  const windowEnd = new Date(now).toISOString();
  const redact = (s: string) => s.split(token).join("[redacted]").slice(0, 300);

  async function query<T>(q: string, variables: Record<string, unknown>): Promise<Outcome<T>> {
    let res: Response;
    try {
      res = await post(CF_GRAPHQL_ENDPOINT, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ query: q, variables }),
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      return { ok: false, message: `request failed: ${redact(e instanceof Error ? e.message : String(e))}` };
    }
    let body: { data?: { viewer?: { zones?: unknown[] } } | null; errors?: { message?: unknown }[] | null } | undefined;
    try {
      body = JSON.parse(await res.text());
    } catch {
      return { ok: false, message: `HTTP ${res.status} with a non-JSON reply` };
    }
    if (body?.errors?.length) return { ok: false, message: redact(`HTTP ${res.status}: ${body.errors.map((e) => String(e?.message ?? "unknown error")).join("; ")}`) };
    if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
    const zone = body?.data?.viewer?.zones?.[0];
    if (!zone) return { ok: false, message: "Cloudflare returned no data for this zone id (wrong id, or the token cannot see this zone)" };
    return { ok: true, value: zone as T };
  }

  const daily = await query<{ httpRequests1dGroups?: { sum?: { requests?: number; bytes?: number }; uniq?: { uniques?: number } }[] }>(DAILY_QUERY, {
    zoneTag: zoneId,
    from: windowStart.slice(0, 10),
    to: windowEnd.slice(0, 10),
  });
  if (!daily.ok) return { status: "error", zoneId, message: `Cloudflare totals query failed: ${daily.message}. No numbers are reported.` };

  const rows = daily.value.httpRequests1dGroups ?? [];
  const totals: NonNullable<CloudflareBaseline["totals"]> = {
    requests: rows.reduce((n, r) => n + (r.sum?.requests ?? 0), 0),
    bytes: rows.reduce((n, r) => n + (r.sum?.bytes ?? 0), 0),
  };
  const notes: string[] = [];
  // Daily unique counts are per day and overlap, so a multi-day sum would overstate visitors.
  if (rows.length === 1 && typeof rows[0]!.uniq?.uniques === "number") totals.uniques = rows[0]!.uniq.uniques;
  else if (rows.length > 1) notes.push("Unique visitors are not shown: daily unique counts overlap and cannot be added.");

  const botRes = await query<{ httpRequestsAdaptiveGroups?: { count?: number; dimensions?: { userAgent?: string } }[] }>(BOT_QUERY, { zoneTag: zoneId, from: windowStart, to: windowEnd });
  let aiBots: CloudflareBaseline["aiBots"];
  if (botRes.ok) {
    const groups = botRes.value.httpRequestsAdaptiveGroups ?? [];
    const byName = new Map<string, number>();
    for (const g of groups) {
      const ua = (g.dimensions?.userAgent ?? "").toLowerCase();
      const name = AI_BOT_TOKENS.find((t) => ua.includes(t.toLowerCase()));
      if (name) byName.set(name, (byName.get(name) ?? 0) + (g.count ?? 0));
    }
    aiBots = [...byName].map(([name, requests]) => ({ name, requests })).sort((a, b) => b.requests - a.requests);
    notes.push("AI-bot counts match crawler names in the user-agent string, which anyone can spoof; they are not verified bots. Bot counts come from Cloudflare's sampled adaptive data, so they are estimates. Crawlers not listed had no matching requests in this window.");
    if (groups.length >= BOT_GROUP_LIMIT) notes.push(`The bot query hit its ${BOT_GROUP_LIMIT}-group limit, so the counts may be incomplete.`);
  } else {
    notes.push(`The AI-bot query failed, so AI-bot counts are not reported: ${botRes.message}.`);
  }

  let deltaVsPrevious: CloudflareBaseline["deltaVsPrevious"];
  if (input.previous) {
    const p = input.previous;
    const comparable = p.status === "ok" && p.totals && p.aiBots && (p.zoneId === undefined || p.zoneId === zoneId);
    if (comparable && aiBots) {
      const sum = (bots: { requests: number }[]) => bots.reduce((n, b) => n + b.requests, 0);
      deltaVsPrevious = { requests: totals.requests - p.totals!.requests, bytes: totals.bytes - p.totals!.bytes, aiBotRequests: sum(aiBots) - sum(p.aiBots!) };
      notes.push("Delta is this result minus the previous one; it is only meaningful when both used the same lookbackDays.");
    } else {
      notes.push("No delta: the previous result is for another zone, or is missing totals or AI-bot counts, or the AI-bot query failed this time.");
    }
  }

  return {
    status: "ok",
    zoneId,
    windowStart,
    windowEnd,
    totals,
    ...(aiBots ? { aiBots } : {}),
    ...(deltaVsPrevious ? { deltaVsPrevious } : {}),
    message: `Read from the Cloudflare GraphQL Analytics API for the last ${lookbackDays} day(s). ${notes.join(" ")}`,
  };
}
