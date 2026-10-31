// One-off, read-only Cloudflare snapshot for the "does this help?" experiment (docs/experiment/PLAN.md).
// Usage: CF_ANALYTICS_API_TOKEN=... CF_ZONE_ID=<32 hex> node --import tsx scripts/experiment-baseline.ts <label> [lookbackDays]
// Writes docs/experiment/snapshot-<label>.json (zone id and token are never written). Numbers are exactly what Cloudflare returned.
import { writeFileSync } from "node:fs";
import { CF_GRAPHQL_ENDPOINT, AI_BOT_TOKENS, snapshotCloudflareBaseline } from "../src/cloudflare.js";

const label = process.argv[2];
const lookbackDays = Number(process.argv[3] ?? 7);
const token = process.env.CF_ANALYTICS_API_TOKEN?.trim();
const zoneId = process.env.CF_ZONE_ID?.trim().toLowerCase();
if (!label || !token || !zoneId) {
  console.error("need <label> argument and CF_ANALYTICS_API_TOKEN + CF_ZONE_ID env");
  process.exit(2);
}
const HOSTS = ["dispatch.tatinc.us", "dispatch-mcp.tatinc.us", "tatinc.us", "shabba.tatinc.us"]; // shabba = control: not submitted during the experiment
const now = Date.now();
const from = new Date(now - lookbackDays * 86_400_000).toISOString();
const to = new Date(now).toISOString();

async function gql(query: string, variables: Record<string, unknown>) {
  const res = await fetch(CF_GRAPHQL_ENDPOINT, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(20_000) });
  const body = (await res.json()) as { data?: any; errors?: { message?: string }[] | null };
  if (body.errors?.length) return { error: body.errors.map((e) => e.message).join("; ").split(token!).join("[redacted]") };
  return { data: body.data?.viewer?.zones?.[0] };
}

const zone = await snapshotCloudflareBaseline({ zoneId, lookbackDays }, { env: { CF_ANALYTICS_API_TOKEN: token } });
const { zoneId: _omit, ...zoneSafe } = zone as Record<string, unknown>;

const perHost: Record<string, unknown> = {};
for (const host of HOSTS) {
  const q = `query ($zoneTag: string, $from: Time, $to: Time) { viewer { zones(filter: { zoneTag: $zoneTag }) {
    all: httpRequestsAdaptiveGroups(limit: 1, filter: { datetime_geq: $from, datetime_lt: $to, requestSource: "eyeball", clientRequestHTTPHost: "${host}" }) { count sum { visits } }
    bots: httpRequestsAdaptiveGroups(limit: 100, orderBy: [count_DESC], filter: { datetime_geq: $from, datetime_lt: $to, requestSource: "eyeball", clientRequestHTTPHost: "${host}", OR: [${AI_BOT_TOKENS.map((t) => `{ userAgent_like: "%${t}%" }`).join(", ")}] }) { count dimensions { userAgent } }
  } } }`;
  const r = await gql(q, { zoneTag: zoneId, from, to });
  if ("error" in r) { perHost[host] = { error: r.error }; continue; }
  const all = r.data?.all?.[0];
  const byName = new Map<string, number>();
  for (const g of r.data?.bots ?? []) {
    const ua = String(g.dimensions?.userAgent ?? "").toLowerCase();
    const name = AI_BOT_TOKENS.find((t) => ua.includes(t.toLowerCase()));
    if (name) byName.set(name, (byName.get(name) ?? 0) + g.count);
  }
  perHost[host] = { requests: all?.count ?? 0, visits: all?.sum?.visits ?? 0, aiBots: Object.fromEntries(byName) };
}

const out = {
  label,
  takenAt: to,
  window: { from, to, lookbackDays },
  zone: zoneSafe,
  perHost,
  caveats: [
    "Source: Cloudflare GraphQL Analytics. Zone totals are the whole tatinc.us zone; per-host numbers are eyeball requests (requestSource=eyeball) from sampled adaptive data, so treat them as estimates.",
    "AI-bot counts match crawler names in the user-agent string, which can be spoofed; Google-Extended and Brave's crawler have no user-agent token and cannot be counted this way.",
  ],
};
writeFileSync(new URL(`../docs/experiment/snapshot-${label}.json`, import.meta.url), JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out, null, 2));
