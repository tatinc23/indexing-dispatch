// Text + structuredContent builders for the discovery tools (clients that only read `content` still get the facts).
import type { AuditResult, CloudflareBaseline, ViesearchResult } from "./contract.js";
import { MORE_PLACES_PATH } from "./format.js";
import { SERVER_INFO } from "./tool-defs.js";

function build<T>(structured: T, lines: string[], failed: boolean) {
  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    structuredContent: structured,
    ...(failed ? { isError: true as const } : {}),
  };
}

export function auditToolResult(r: AuditResult) {
  const lines = [`${r.status.toUpperCase()} - ${r.finalUrl ?? r.targetUrl}`, r.message];
  for (const f of r.findings) lines.push(`[${f.severity}] ${f.message}`);
  if (r.pageSpeed) {
    lines.push(
      r.pageSpeed.status === "ok"
        ? `PageSpeed (${r.pageSpeed.strategy ?? "?"}): performance ${r.pageSpeed.performanceScore ?? "n/a"}, SEO ${r.pageSpeed.seoScore ?? "n/a"}`
        : `PageSpeed ${r.pageSpeed.status}: ${r.pageSpeed.reason ?? "no reason given"}`,
    );
  }
  if (r.suggestedFiles.length) lines.push(`Suggested files (drafted from observed facts): ${r.suggestedFiles.map((f) => f.path).join(", ")}`);
  lines.push(`(${(r.durationMs / 1000).toFixed(1)}s)`);
  return build(r, lines, r.status !== "ok");
}

export function viesearchToolResult(r: ViesearchResult) {
  const head = `${r.status.toUpperCase()}${r.errorCode ? ` (${r.errorCode})` : ""} — ${r.targetUrl}`;
  const lines = [head, r.message];
  if (r.confirmationText) lines.push(`Viesearch said: "${r.confirmationText}"`);
  if (r.retryAfterSeconds) lines.push(`Do not retry before ${r.retryAfterSeconds}s.`);
  lines.push(`More places to submit yourself: ${SERVER_INFO.websiteUrl}${MORE_PLACES_PATH}`);
  lines.push(`(${(r.durationMs / 1000).toFixed(1)}s)`);
  return build(r, lines, r.status !== "accepted");
}

export function cloudflareToolResult(r: CloudflareBaseline) {
  const lines = [`${r.status.toUpperCase()}${r.zoneId ? ` - zone ${r.zoneId}` : ""}`, r.message];
  if (r.totals) lines.push(`requests: ${r.totals.requests}, bytes: ${r.totals.bytes}${r.totals.uniques === undefined ? "" : `, uniques: ${r.totals.uniques}`}`);
  if (r.aiBots?.length) lines.push(`AI crawlers (by user-agent): ${r.aiBots.map((b) => `${b.name}: ${b.requests}`).join(", ")}`);
  if (r.deltaVsPrevious) lines.push(`Change vs previous: requests ${r.deltaVsPrevious.requests}, bytes ${r.deltaVsPrevious.bytes}, AI-bot requests ${r.deltaVsPrevious.aiBotRequests}`);
  return build(r, lines, r.status !== "ok");
}
