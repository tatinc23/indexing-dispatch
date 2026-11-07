import type { SubmitResult } from "./schema.js";
import { SERVER_INFO } from "./tool-defs.js";

/** More directories worth a human visit; there is no agent path for them. */
export const MORE_PLACES_PATH = "/more-places";

/** Concise text for MCP clients that only read `content`. */
export function summarize(r: SubmitResult): string {
  const head = `${r.status.toUpperCase()}${r.errorCode ? ` (${r.errorCode})` : ""} — ${r.targetUrl}`;
  const lines = [head, r.message];
  if (r.confirmationText) lines.push(`Brave said: "${r.confirmationText}"`);
  if (r.retryAfterSeconds) lines.push(`Do not retry before ${r.retryAfterSeconds}s.`);
  lines.push(`More places to submit yourself: ${SERVER_INFO.websiteUrl}${MORE_PLACES_PATH}`);
  lines.push(`(${(r.durationMs / 1000).toFixed(1)}s)`);
  return lines.join("\n");
}

/** Builds the tool result: text + structuredContent, a screenshot when there is one, isError unless accepted. */
export function toToolResult(result: SubmitResult, screenshot?: string) {
  const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [
    { type: "text", text: summarize(result) },
  ];
  if (screenshot) content.push({ type: "image", data: screenshot, mimeType: "image/jpeg" });
  return {
    content,
    structuredContent: result,
    ...(result.status === "accepted" ? {} : { isError: true }),
  };
}
