// Text + structuredContent builders for the discovery tools (clients that only read `content` still get the facts).
import { VIESEARCH_CONFIRM_LINE, type AuditResult, type CloudflareBaseline, type ViesearchResult } from "./contract.js";
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
  // Every Viesearch result carries the email-confirmation reminder in BOTH the text and the
  // structured message (2026-11-08: Viesearch emails a "Confirm Submission" step after the form).
  const out: ViesearchResult = r.message.includes(VIESEARCH_CONFIRM_LINE)
    ? r
    : { ...r, message: `${r.message} ${VIESEARCH_CONFIRM_LINE}` };
  const head = `${out.status.toUpperCase()}${out.errorCode ? ` (${out.errorCode})` : ""} — ${out.targetUrl}`;
  const lines = [head, out.message];
  if (out.confirmationText) lines.push(`Viesearch said: "${out.confirmationText}"`);
  if (out.retryAfterSeconds) lines.push(`Do not retry before ${out.retryAfterSeconds}s.`);
  lines.push(`More places to submit yourself: ${SERVER_INFO.websiteUrl}${MORE_PLACES_PATH}`);
  lines.push(`(${(out.durationMs / 1000).toFixed(1)}s)`);
  return build(out, lines, out.status !== "accepted");
}

export function cloudflareToolResult(r: CloudflareBaseline) {
  const lines = [`${r.status.toUpperCase()}${r.zoneId ? ` - zone ${r.zoneId}` : ""}`, r.message];
  if (r.totals) lines.push(`requests: ${r.totals.requests}, bytes: ${r.totals.bytes}${r.totals.uniques === undefined ? "" : `, uniques: ${r.totals.uniques}`}`);
  if (r.aiBots?.length) lines.push(`AI crawlers (by user-agent): ${r.aiBots.map((b) => `${b.name}: ${b.requests}`).join(", ")}`);
  if (r.deltaVsPrevious) lines.push(`Change vs previous: requests ${r.deltaVsPrevious.requests}, bytes ${r.deltaVsPrevious.bytes}, AI-bot requests ${r.deltaVsPrevious.aiBotRequests}`);
  return build(r, lines, r.status !== "ok");
}
