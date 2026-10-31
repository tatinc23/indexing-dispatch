import { MCPServer, isBuilding } from "mcp-use";
import { z } from "zod";
import { auditSite } from "./src/audit.js";
import { parseAllowedZones, snapshotCloudflareBaseline, zoneAllowed } from "./src/cloudflare.js";
import { auditResultSchema, canvasPropsSchema, cloudflareBaselineSchema, indexNowResultSchema, type AuditResult, type CanvasProps, type IndexNowResult } from "./src/contract.js";
import { auditToolResult, cloudflareToolResult, indexNowToolResult } from "./src/discovery-format.js";
import { toToolResult } from "./src/format.js";
import { SERVER_INFO, auditSiteDef, renderSubmissionCanvasDef, submitBraveUrlDef, submitIndexnowDef } from "./src/tool-defs.js";
import { SubmissionGuard, bearerMatches, configFromEnv, dedupeKey, dedupeSetKey } from "./src/guard.js";
import { submitIndexNow } from "./src/indexnow.js";
import { inputSchema, resultSchema, type SubmitResult } from "./src/schema.js";
import { runBrowserSelfCheck } from "./src/selfcheck.js";
import { submitToBrave } from "./src/submit.js";

const server = new MCPServer({ ...SERVER_INFO, icons: SERVER_INFO.icons.map((i) => ({ ...i, sizes: [...i.sizes] })) });

// ACCESS: public access is an explicit choice. With BRAVE_SUBMITTER_API_KEY set, every tools/call needs
// `Authorization: Bearer <key>`. Without it, tools/call is refused unless BRAVE_SUBMITTER_ALLOW_PUBLIC=true.
// tools/list stays open so clients can discover the tool and its auth requirement.
const apiKey = process.env.BRAVE_SUBMITTER_API_KEY?.trim() || undefined;
const allowPublic = process.env.BRAVE_SUBMITTER_ALLOW_PUBLIC === "true";
server.use("mcp:tools/call", async (ctx, next) => {
  if (apiKey) {
    if (!bearerMatches(ctx.request?.header("authorization"), apiKey)) {
      throw new Error("Unauthorized: send 'Authorization: Bearer <key>' with this request.");
    }
  } else if (!allowPublic) {
    throw new Error(
      "Access not configured: set BRAVE_SUBMITTER_API_KEY (authenticated) or BRAVE_SUBMITTER_ALLOW_PUBLIC=true (public) on the server.",
    );
  }
  return next();
});

// Per-process limits only (see src/guard.ts); the Manufact gateway can add per-caller rate limiting on top.
const guard = new SubmissionGuard(configFromEnv());

export const submitBraveUrl = server.tool(
  submitBraveUrlDef,
  async ({ targetUrl }) => {
    const gate = guard.tryAcquire(dedupeKey(targetUrl));
    if (!gate.ok) {
      const denied: SubmitResult = {
        targetUrl,
        status: "error",
        errorCode: gate.code,
        message: gate.message,
        retryAfterSeconds: gate.retryAfterSeconds,
        durationMs: 0,
      };
      console.log(JSON.stringify({ event: "submit-denied", code: gate.code }));
      return toToolResult(denied);
    }

    let clicked = false;
    try {
      const outcome = await submitToBrave(targetUrl);
      clicked = outcome.clicked;
      const { origin, pathname } = new URL(targetUrl);
      console.log(
        JSON.stringify({ event: "submit-finished", target: origin + pathname, status: outcome.result.status, errorCode: outcome.result.errorCode, durationMs: outcome.result.durationMs }),
      );
      return toToolResult(outcome.result, outcome.screenshot);
    } finally {
      gate.release({ clicked });
    }
  },
);

// ---- Discovery suite -------------------------------------------------------------------------------------------
// Per-process budgets, same in-memory style as the Brave guard (a restart or scale-out resets them).
//   submit-indexnow: 1 at a time, 6 submissions/hour, identical (host + URL set) not resent for 1 h.
//   audit-site:      3 at a time, 40/hour, no dedupe (it only reads).
const indexNowGuard = new SubmissionGuard(
  { maxConcurrent: 1, maxPerWindow: 6, windowMs: 60 * 60 * 1000, dedupeMs: 60 * 60 * 1000 },
  undefined,
  { target: "IndexNow", running: "IndexNow submission", unit: "IndexNow submissions" },
);
const auditGuard = new SubmissionGuard(
  { maxConcurrent: 3, maxPerWindow: 40, windowMs: 60 * 60 * 1000, dedupeMs: 60 * 60 * 1000 },
  undefined,
  { target: "the audit", running: "site audit", unit: "site audits" },
);

export const submitIndexnow = server.tool(
  submitIndexnowDef,
  async (input) => {
    const keyLocation = input.keyLocation || `https://${input.host.toLowerCase()}/${input.key}.txt`;
    const gate = indexNowGuard.tryAcquire(dedupeSetKey(input.host, input.urls));
    if (!gate.ok) {
      const denied: IndexNowResult = {
        status: "error",
        host: input.host.toLowerCase(),
        urlCount: input.urls.length,
        keyLocation,
        keyVerified: false,
        engines: [],
        message: `${gate.message} Retry after about ${gate.retryAfterSeconds} seconds. Nothing was sent.`,
        durationMs: 0,
      };
      console.log(JSON.stringify({ event: "indexnow-denied", code: gate.code }));
      return indexNowToolResult(denied);
    }
    let pinged = false;
    try {
      const result = await submitIndexNow(input);
      pinged = result.engines.length > 0;
      console.log(JSON.stringify({ event: "indexnow-finished", host: result.host, status: result.status, urlCount: result.urlCount }));
      return indexNowToolResult(result);
    } finally {
      gate.release({ clicked: pinged });
    }
  },
);

export const auditSiteTool = server.tool(
  auditSiteDef,
  async ({ targetUrl, strategy }) => {
    const gate = auditGuard.tryAcquire(`${Date.now()}:${Math.random()}`);
    if (!gate.ok) {
      const denied: AuditResult = {
        status: "error",
        targetUrl,
        message: `${gate.message} Retry after about ${gate.retryAfterSeconds} seconds.`,
        findings: [],
        suggestedFiles: [],
        durationMs: 0,
      };
      console.log(JSON.stringify({ event: "audit-denied", code: gate.code }));
      return auditToolResult(denied);
    }
    try {
      const result = await auditSite({ targetUrl, ...(strategy ? { strategy } : {}) });
      console.log(JSON.stringify({ event: "audit-finished", status: result.status, durationMs: result.durationMs }));
      return auditToolResult(result);
    } finally {
      gate.release({ clicked: false });
    }
  },
);

// Registered only when the operator supplied a token; the token itself is never a tool argument.
// It also needs CF_ZONE_IDS: the token can usually read every zone on the account, so callers may only query zones the operator listed.
const allowedZones = parseAllowedZones(process.env.CF_ZONE_IDS);
const cloudflareConfigured = Boolean(process.env.CF_ANALYTICS_API_TOKEN?.trim()) && allowedZones.size > 0;
const cloudflareGuard = new SubmissionGuard(
  { maxConcurrent: 2, maxPerWindow: 20, windowMs: 60 * 60 * 1000, dedupeMs: 0 },
  undefined,
  { target: "the Cloudflare snapshot", running: "Cloudflare snapshot", unit: "Cloudflare snapshots" },
);
if (cloudflareConfigured) {
  server.tool(
    {
      name: "snapshot-cloudflare-baseline",
      title: "Snapshot Cloudflare traffic baseline",
      description:
        "Reads request, byte and (single-day) unique counts for one Cloudflare zone, plus requests whose user-agent names an AI crawler (GPTBot, OAI-SearchBot, ClaudeBot, PerplexityBot and similar). Uses the operator's read-only analytics token. Crawler counts are matched by user-agent string, which can be spoofed, and come from sampled data, so treat them as estimates. Pass an earlier result as `previous` to get the change; nothing is stored between calls.",
      inputSchema: z.object({
        zoneId: z.string().trim().min(1).max(64).describe("32-character hexadecimal Cloudflare zone id."),
        lookbackDays: z.number().int().optional().describe("Days to look back, 1-30. Default 7."),
        previous: cloudflareBaselineSchema.optional().describe("An earlier result of this tool, to compute the change since then."),
      }),
      outputSchema: cloudflareBaselineSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input) => {
      if (!zoneAllowed(input.zoneId, allowedZones)) {
        console.log(JSON.stringify({ event: "cloudflare-denied", code: "zone_not_allowed" }));
        return cloudflareToolResult({ status: "error", message: "This server only reports on zones its operator has listed, and that zone is not one of them." });
      }
      const gate = cloudflareGuard.tryAcquire(`${Date.now()}:${Math.random()}`);
      if (!gate.ok) {
        console.log(JSON.stringify({ event: "cloudflare-denied", code: gate.code }));
        return cloudflareToolResult({ status: "error", message: `${gate.message} Retry after about ${gate.retryAfterSeconds} seconds.` });
      }
      try {
        const result = await snapshotCloudflareBaseline(input);
        console.log(JSON.stringify({ event: "cloudflare-finished", status: result.status }));
        return cloudflareToolResult(result);
      } finally {
        gate.release({ clicked: false });
      }
    },
  );
}

export const renderSubmissionCanvas = server.tool(
  renderSubmissionCanvasDef,
  async ({ urls, domain, mode }) => {
    const props: CanvasProps = {
      initialUrls: urls ?? [],
      ...(domain ? { domain } : {}),
      mode: mode ?? "interactive",
      enabledTools: { cloudflare: cloudflareConfigured, pageSpeed: Boolean(process.env.PAGESPEED_API_KEY?.trim()) },
    };
    return { content: [{ type: "text", text: "Canvas opened." }], structuredContent: props };
  },
);

// Boot-time Chromium check (logs only, never contacts Brave). Skipped during `mcp-use build`; disable with BRAVE_SUBMITTER_SELFCHECK=0.
if (!isBuilding() && process.env.BRAVE_SUBMITTER_SELFCHECK !== "0") void runBrowserSelfCheck();

export default server;
