import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { snapshotCloudflareBaseline, type CloudflareDeps } from "../src/cloudflare.js";

const ZONE = "0123456789abcdef0123456789abcdef";
const TOKEN = "cf-secret-token-value-123";
const NOW = Date.parse("2026-10-27T12:00:00Z");

const days = (rows: { date: string; requests: number; bytes: number; uniques: number }[]) => ({
  data: { viewer: { zones: [{ httpRequests1dGroups: rows.map((r) => ({ dimensions: { date: r.date }, sum: { requests: r.requests, bytes: r.bytes }, uniq: { uniques: r.uniques } })) }] } },
});
const bots = (rows: { ua: string; count: number }[]) => ({
  data: { viewer: { zones: [{ httpRequestsAdaptiveGroups: rows.map((r) => ({ count: r.count, dimensions: { userAgent: r.ua, verifiedBotCategory: "" } })) }] } },
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Sent {
  url: string;
  init: RequestInit;
  body: { query: string; variables: Record<string, unknown> };
}
/** Routes by which dataset the query asks for. */
function deps(handlers: { daily?: () => Response; adaptive?: () => Response }, env: Record<string, string | undefined> = { CF_ANALYTICS_API_TOKEN: TOKEN }): { d: CloudflareDeps; sent: Sent[] } {
  const sent: Sent[] = [];
  const d: CloudflareDeps = {
    env,
    now: () => NOW,
    fetch: async (url, init) => {
      const body = JSON.parse(String(init?.body));
      sent.push({ url: String(url), init: init ?? {}, body });
      if (/httpRequests1dGroups/.test(body.query)) return (handlers.daily ?? (() => json(days([]))))();
      return (handlers.adaptive ?? (() => json(bots([]))))();
    },
  };
  return { d, sent };
}

describe("snapshotCloudflareBaseline configuration", () => {
  it("returns not_configured without a token and makes no request", async () => {
    for (const env of [{}, { CF_ANALYTICS_API_TOKEN: "" }, { CF_ANALYTICS_API_TOKEN: "   " }]) {
      const { d, sent } = deps({}, env);
      const r = await snapshotCloudflareBaseline({ zoneId: ZONE }, d);
      assert.equal(r.status, "not_configured");
      assert.match(r.message, /CF_ANALYTICS_API_TOKEN/);
      assert.equal(sent.length, 0);
    }
  });

  it("validates the zone id as 32 hex characters before any request", async () => {
    for (const z of ["", "abc", "g".repeat(32), `${ZONE}0`, "../../etc"]) {
      const { d, sent } = deps({});
      const r = await snapshotCloudflareBaseline({ zoneId: z }, d);
      assert.equal(r.status, "error", z);
      assert.match(r.message, /zone/i);
      assert.equal(sent.length, 0);
    }
  });

  it("takes the token only from env: it is not a parameter and never appears in results", async () => {
    const { d, sent } = deps({ daily: () => json({ errors: [{ message: `bad token ${TOKEN}` }] }, 400) });
    const r = await snapshotCloudflareBaseline({ zoneId: ZONE, token: "attacker" } as never, d);
    assert.equal(sent[0]!.init.headers && (sent[0]!.init.headers as Record<string, string>).authorization, `Bearer ${TOKEN}`);
    assert.equal(JSON.stringify(r).includes(TOKEN), false);
    assert.equal(r.status, "error");
  });
});

describe("snapshotCloudflareBaseline queries", () => {
  it("posts to the GraphQL endpoint with variables and never interpolates the zone id", async () => {
    const { d, sent } = deps({});
    await snapshotCloudflareBaseline({ zoneId: ZONE }, d);
    assert.equal(sent.length, 2);
    for (const s of sent) {
      assert.equal(s.url, "https://api.cloudflare.com/client/v4/graphql");
      assert.equal(s.init.method, "POST");
      assert.equal(s.body.variables.zoneTag, ZONE);
      assert.equal(s.body.query.includes(ZONE), false);
    }
    assert.match(sent[0]!.body.query, /httpRequests1dGroups/);
    assert.match(sent[0]!.body.query, /uniq\s*\{\s*uniques/);
    assert.match(sent[1]!.body.query, /httpRequestsAdaptiveGroups/);
    assert.match(sent[1]!.body.query, /userAgent_like/);
    assert.match(sent[1]!.body.query, /GPTBot/);
  });

  it("defaults to 7 days, clamps to 1..30, and reports the window", async () => {
    const a = deps({});
    const r7 = await snapshotCloudflareBaseline({ zoneId: ZONE }, a.d);
    assert.equal(r7.windowEnd, "2026-10-27T12:00:00.000Z");
    assert.equal(r7.windowStart, "2026-10-20T12:00:00.000Z");
    assert.equal(a.sent[0]!.body.variables.from, "2026-10-20");
    assert.equal(a.sent[0]!.body.variables.to, "2026-10-27");
    const b = deps({});
    assert.equal((await snapshotCloudflareBaseline({ zoneId: ZONE, lookbackDays: 500 }, b.d)).windowStart, "2026-09-27T12:00:00.000Z");
    const c = deps({});
    assert.equal((await snapshotCloudflareBaseline({ zoneId: ZONE, lookbackDays: 0 }, c.d)).windowStart, "2026-10-26T12:00:00.000Z");
    const e = deps({});
    assert.equal((await snapshotCloudflareBaseline({ zoneId: ZONE, lookbackDays: Number.NaN }, e.d)).windowStart, "2026-10-20T12:00:00.000Z");
  });
});

describe("snapshotCloudflareBaseline results", () => {
  const daily = () =>
    json(
      days([
        { date: "2026-10-26", requests: 100, bytes: 1000, uniques: 10 },
        { date: "2026-10-27", requests: 50, bytes: 500, uniques: 7 },
      ]),
    );
  const adaptive = () =>
    json(
      bots([
        { ua: "Mozilla/5.0 (compatible; GPTBot/1.4; +https://openai.com/gptbot)", count: 7 },
        { ua: "Mozilla/5.0 (compatible; gptbot/1.2)", count: 3 },
        { ua: "ClaudeBot/1.0", count: 2 },
        { ua: "Mozilla/5.0 (compatible; Claude-SearchBot/1.0)", count: 4 },
        { ua: "Mozilla/5.0 compatible; PerplexityBot/1.0", count: 1 },
      ]),
    );

  it("sums totals and groups AI-bot user agents by name", async () => {
    const { d } = deps({ daily, adaptive });
    const r = await snapshotCloudflareBaseline({ zoneId: ZONE }, d);
    assert.equal(r.status, "ok");
    assert.equal(r.zoneId, ZONE);
    assert.deepEqual(r.totals, { requests: 150, bytes: 1500 });
    assert.deepEqual(
      [...(r.aiBots ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
      [
        { name: "Claude-SearchBot", requests: 4 },
        { name: "ClaudeBot", requests: 2 },
        { name: "GPTBot", requests: 10 },
        { name: "PerplexityBot", requests: 1 },
      ],
    );
  });

  it("omits uniques over several days (daily uniques do not add up) but reports them for one day", async () => {
    const { d } = deps({ daily, adaptive });
    assert.equal((await snapshotCloudflareBaseline({ zoneId: ZONE }, d)).totals?.uniques, undefined);
    const one = deps({ daily: () => json(days([{ date: "2026-10-27", requests: 5, bytes: 9, uniques: 3 }])) });
    assert.equal((await snapshotCloudflareBaseline({ zoneId: ZONE, lookbackDays: 1 }, one.d)).totals?.uniques, 3);
  });

  it("states the user-agent and sampling caveats and that unlisted bots had no matches", async () => {
    const { d } = deps({ daily, adaptive });
    const r = await snapshotCloudflareBaseline({ zoneId: ZONE }, d);
    assert.match(r.message, /user-agent/i);
    assert.match(r.message, /spoof/i);
    assert.match(r.message, /sampl/i);
  });

  it("does not fabricate: an empty zone is zero requests, not an error", async () => {
    const { d } = deps({});
    const r = await snapshotCloudflareBaseline({ zoneId: ZONE }, d);
    assert.equal(r.status, "ok");
    assert.deepEqual(r.totals, { requests: 0, bytes: 0 });
    assert.deepEqual(r.aiBots, []);
  });

  it("reports GraphQL errors from the daily query as an error with no numbers", async () => {
    const { d } = deps({ daily: () => json({ data: null, errors: [{ message: "query time range is too large for your plan" }] }) });
    const r = await snapshotCloudflareBaseline({ zoneId: ZONE }, d);
    assert.equal(r.status, "error");
    assert.match(r.message, /time range is too large/);
    assert.equal(r.totals, undefined);
  });

  it("keeps the totals but omits aiBots when only the bot query fails, and says so", async () => {
    const { d } = deps({ daily, adaptive: () => json({ data: null, errors: [{ message: "cannot query more than 1d for this plan" }] }) });
    const r = await snapshotCloudflareBaseline({ zoneId: ZONE }, d);
    assert.equal(r.status, "ok");
    assert.deepEqual(r.totals, { requests: 150, bytes: 1500 });
    assert.equal(r.aiBots, undefined);
    assert.match(r.message, /cannot query more than 1d/);
    assert.match(r.message, /AI-bot/i);
  });

  it("reports HTTP failures and network errors, redacting the token, without retrying", async () => {
    const http = deps({ daily: () => json({ errors: [{ message: "Authentication error" }] }, 403) });
    const r1 = await snapshotCloudflareBaseline({ zoneId: ZONE }, http.d);
    assert.equal(r1.status, "error");
    assert.match(r1.message, /403|Authentication/);
    assert.equal(http.sent.length, 1);

    const net: CloudflareDeps = { env: { CF_ANALYTICS_API_TOKEN: TOKEN }, now: () => NOW, fetch: async () => { throw new Error(`connect failed with ${TOKEN}`); } };
    const r2 = await snapshotCloudflareBaseline({ zoneId: ZONE }, net);
    assert.equal(r2.status, "error");
    assert.equal(JSON.stringify(r2).includes(TOKEN), false);
  });

  it("reports a non-JSON reply as an error", async () => {
    const { d } = deps({ daily: () => new Response("<html>bad gateway</html>", { status: 502 }) });
    assert.equal((await snapshotCloudflareBaseline({ zoneId: ZONE }, d)).status, "error");
  });

  it("flags a zone that is not visible to the token (empty zones array)", async () => {
    const { d } = deps({ daily: () => json({ data: { viewer: { zones: [] } } }) });
    const r = await snapshotCloudflareBaseline({ zoneId: ZONE }, d);
    assert.equal(r.status, "error");
    assert.match(r.message, /zone/i);
  });
});

describe("snapshotCloudflareBaseline deltaVsPrevious", () => {
  const dailyNow = () => json(days([{ date: "2026-10-27", requests: 150, bytes: 1500, uniques: 5 }]));
  const adaptiveNow = () => json(bots([{ ua: "GPTBot/1.4", count: 10 }]));
  const previous = { status: "ok" as const, message: "x", zoneId: ZONE, totals: { requests: 100, bytes: 2000 }, aiBots: [{ name: "GPTBot", requests: 4 }, { name: "ClaudeBot", requests: 1 }] };

  it("computes current minus previous", async () => {
    const { d } = deps({ daily: dailyNow, adaptive: adaptiveNow });
    const r = await snapshotCloudflareBaseline({ zoneId: ZONE, previous }, d);
    assert.deepEqual(r.deltaVsPrevious, { requests: 50, bytes: -500, aiBotRequests: 5 });
  });

  it("omits the delta and says why when previous is for another zone or lacks data", async () => {
    for (const prev of [{ ...previous, zoneId: "f".repeat(32) }, { status: "not_configured" as const, message: "no" }, { ...previous, aiBots: undefined }]) {
      const { d } = deps({ daily: dailyNow, adaptive: adaptiveNow });
      const r = await snapshotCloudflareBaseline({ zoneId: ZONE, previous: prev }, d);
      assert.equal(r.deltaVsPrevious, undefined);
      assert.match(r.message, /previous/i);
    }
  });

  it("omits the delta when the bot query failed this time", async () => {
    const { d } = deps({ daily: dailyNow, adaptive: () => json({ errors: [{ message: "nope" }] }) });
    const r = await snapshotCloudflareBaseline({ zoneId: ZONE, previous }, d);
    assert.equal(r.deltaVsPrevious, undefined);
  });
});

import { parseAllowedZones, zoneAllowed } from "../src/cloudflare.js";
describe("zone allowlist", () => {
  const a = "a".repeat(32);
  const b = "B".repeat(32);
  it("parses comma/space separated 32-hex ids, ignores junk, lowercases", () => {
    const set = parseAllowedZones(`${a}, ${b} nothex, ${"c".repeat(31)}`);
    assert.deepEqual([...set].sort(), [a, "b".repeat(32)]);
  });
  it("is empty (tool not offered) when unset or invalid", () => {
    assert.equal(parseAllowedZones(undefined).size, 0);
    assert.equal(parseAllowedZones("  ,, xyz").size, 0);
  });
  it("only allows listed zones, case-insensitively", () => {
    const set = parseAllowedZones(a);
    assert.equal(zoneAllowed(a.toUpperCase(), set), true);
    assert.equal(zoneAllowed("d".repeat(32), set), false);
  });
});
