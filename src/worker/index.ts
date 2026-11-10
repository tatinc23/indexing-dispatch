// Cloudflare Workers entry for the Indexing Dispatch MCP server (https://dispatch-mcp.tatinc.us/mcp).
// Same four public tools, contracts and honesty rules as the Node entry (index.ts); runtime adapters differ:
//   submit-brave-url  -> Browser Run via @cloudflare/puppeteer (src/worker/brave-browser-run.ts)
//   safe fetches      -> DoH-checked fetch (src/worker/safe-fetch-worker.ts, via the "#safe-fetch" import)
//   limits            -> ONE global Durable Object (src/worker/limiter-do.ts + src/limits.ts), incl. a daily browser-time budget
// snapshot-cloudflare-baseline is not offered here (self-host only; it needs an operator token). See docs/cloudflare-port-plan.md.
import { env } from "cloudflare:workers";
import { MCPServer, registerViews, type ViewsManifest } from "mcp-use";
import { auditSite } from "../audit.js";
import type { CanvasProps, ViesearchResult } from "../contract.js";
import { auditToolResult, viesearchToolResult } from "../discovery-format.js";
import { toToolResult } from "../format.js";
import { bearerMatches, dedupeKey } from "../guard.js";
import type { BudgetKind, LedgerDenied, LedgerGranted } from "../limits.js";
import { SERVER_INFO, auditDenied, auditSiteDef, braveDenied, checkMySitePromptDef, checkMySitePromptSchema, checkMySitePromptText, renderSubmissionCanvasDef, submitBraveUrlDef, submitMySitePromptDef, submitMySitePromptSchema, submitMySitePromptText, submitViesearchUrlDef, viesearchDenied } from "../tool-defs.js";
import { submitViaBrowserRun } from "./brave-browser-run.js";
import { submitViaViesearchRun } from "./viesearch-browser-run.js";
import manifestTemplate from "../../site/mcp.json";
import viewAssets from "./generated/view-assets.json";
import views from "./generated/views-manifest.json";
import type { BudgetLimiter } from "./limiter-do.js";

export { BudgetLimiter } from "./limiter-do.js";

export interface WorkerEnv {
  BROWSER: Fetcher;
  LIMITER: DurableObjectNamespace<BudgetLimiter>;
  BRAVE_SUBMITTER_ALLOW_PUBLIC?: string;
  BRAVE_SUBMITTER_API_KEY?: string;
  PAGESPEED_API_KEY?: string;
  /** Where the public page lives; GET / redirects there. */
  PUBLIC_PAGE_URL?: string;
}
const cfg = env as unknown as WorkerEnv;

const server = new MCPServer({
  ...SERVER_INFO,
  instructions: SERVER_INFO.instructions.replace("Limits are per server instance and in memory.", "Limits are global for this server: every caller shares them."),
  icons: SERVER_INFO.icons.map((i) => ({ ...i, sizes: [...i.sizes] })),
});
server[registerViews](views as unknown as ViewsManifest, { assets: viewAssets as Record<string, { body: string; contentType: string }> });

// ACCESS: identical semantics to the Node entry. Public only when BRAVE_SUBMITTER_ALLOW_PUBLIC=true (set in wrangler.jsonc).
server.use("mcp:tools/call", async (ctx, next) => {
  const apiKey = cfg.BRAVE_SUBMITTER_API_KEY?.trim() || undefined;
  if (apiKey) {
    if (!bearerMatches(ctx.request?.header("authorization"), apiKey)) throw new Error("Unauthorized: send 'Authorization: Bearer <key>' with this request.");
  } else if (cfg.BRAVE_SUBMITTER_ALLOW_PUBLIC !== "true") {
    throw new Error("Access not configured: set BRAVE_SUBMITTER_API_KEY (authenticated) or BRAVE_SUBMITTER_ALLOW_PUBLIC=true (public) on the server.");
  }
  return next();
});

const limiter = () => cfg.LIMITER.get(cfg.LIMITER.idFromName("global"));

/** Asks the global limiter. Fails closed: if the limiter cannot be reached, nothing is sent. */
async function acquire(kind: BudgetKind, key: string): Promise<LedgerGranted | LedgerDenied> {
  try {
    return await limiter().acquire(kind, key);
  } catch (e) {
    console.log(JSON.stringify({ event: "limiter-unavailable", kind, error: String(e).slice(0, 200) }));
    return { ok: false, code: "busy", message: "This server's rate limiter could not be reached, so nothing was sent. Try again in a minute.", retryAfterSeconds: 60 };
  }
}
async function release(kind: BudgetKind, leaseId: string, outcome: { sent: boolean; browserMs?: number }): Promise<void> {
  try {
    await limiter().release(kind, leaseId, outcome);
  } catch (e) {
    // The lease expires on its own and is then charged in full (src/limits.ts), so a lost release never under-counts.
    console.log(JSON.stringify({ event: "limiter-release-failed", kind, error: String(e).slice(0, 200) }));
  }
}

export const submitBraveUrl = server.tool(submitBraveUrlDef, async ({ targetUrl }) => {
  const gate = await acquire("brave", dedupeKey(targetUrl));
  if (!gate.ok) {
    console.log(JSON.stringify({ event: "submit-denied", code: gate.code }));
    return toToolResult(braveDenied(targetUrl, gate));
  }
  let clicked = false;
  let browserMs: number | undefined;
  try {
    const outcome = await submitViaBrowserRun(targetUrl, cfg.BROWSER);
    clicked = outcome.clicked;
    browserMs = outcome.browserMs;
    const { origin, pathname } = new URL(targetUrl);
    console.log(JSON.stringify({ event: "submit-finished", target: origin + pathname, status: outcome.result.status, errorCode: outcome.result.errorCode, durationMs: outcome.result.durationMs, browserMs }));
    return toToolResult(outcome.result, outcome.screenshot);
  } finally {
    await release("brave", gate.leaseId, { sent: clicked, ...(browserMs === undefined ? {} : { browserMs }) });
  }
});

export const submitViesearchUrl = server.tool(submitViesearchUrlDef, async ({ targetUrl, contactEmail }) => {
  const gate = await acquire("viesearch", dedupeKey(targetUrl));
  if (!gate.ok) {
    // Never log the email: only the outcome code is recorded.
    console.log(JSON.stringify({ event: "viesearch-denied", code: gate.code }));
    return viesearchToolResult(viesearchDenied(targetUrl, gate));
  }
  let clicked = false;
  let browserMs: number | undefined;
  try {
    const outcome = await submitViaViesearchRun(targetUrl, contactEmail, cfg.BROWSER);
    clicked = outcome.clicked;
    browserMs = outcome.browserMs;
    const { origin, pathname } = new URL(targetUrl);
    console.log(JSON.stringify({ event: "viesearch-finished", target: origin + pathname, status: outcome.result.status, errorCode: outcome.result.errorCode, durationMs: outcome.result.durationMs, browserMs }));
    return viesearchToolResult(outcome.result as ViesearchResult);
  } finally {
    await release("viesearch", gate.leaseId, { sent: clicked, ...(browserMs === undefined ? {} : { browserMs }) });
  }
});

export const auditSiteTool = server.tool(auditSiteDef, async ({ targetUrl, strategy }) => {
  const gate = await acquire("audit", crypto.randomUUID());
  if (!gate.ok) {
    console.log(JSON.stringify({ event: "audit-denied", code: gate.code }));
    return auditToolResult(auditDenied(targetUrl, gate));
  }
  try {
    const result = await auditSite({ targetUrl, ...(strategy ? { strategy } : {}) }, { env: { PAGESPEED_API_KEY: cfg.PAGESPEED_API_KEY } });
    console.log(JSON.stringify({ event: "audit-finished", status: result.status, durationMs: result.durationMs }));
    return auditToolResult(result);
  } finally {
    await release("audit", gate.leaseId, { sent: false });
  }
});

export const renderSubmissionCanvas = server.tool(renderSubmissionCanvasDef, async ({ urls, domain, mode }) => {
  const props: CanvasProps = {
    initialUrls: urls ?? [],
    ...(domain ? { domain } : {}),
    mode: mode ?? "interactive",
    enabledTools: { cloudflare: false, pageSpeed: Boolean(cfg.PAGESPEED_API_KEY?.trim()) },
  };
  return { content: [{ type: "text", text: "Canvas opened." }], structuredContent: props };
});

export const submitMySitePrompt = server.prompt({ ...submitMySitePromptDef, schema: submitMySitePromptSchema }, async ({ url, email }) => ({
  messages: [{ role: "user" as const, content: { type: "text" as const, text: submitMySitePromptText(url, email?.trim() ? email.trim() : undefined) } }],
}));

export const checkMySitePrompt = server.prompt({ ...checkMySitePromptDef, schema: checkMySitePromptSchema }, async ({ url }) => ({
  messages: [{ role: "user" as const, content: { type: "text" as const, text: checkMySitePromptText(url) } }],
}));

// ---- HTTP surface: only the MCP endpoint, a tiny info document at GET /, and 404 for everything else. --------------

const SECURITY_HEADERS: Record<string, string> = {
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
};
const LOCKED_CSP = "default-src 'none'; frame-ancestors 'none'";

function withHeaders(res: Response, csp: boolean): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  if (csp) out.headers.set("content-security-policy", LOCKED_CSP);
  out.headers.delete("x-powered-by");
  return out;
}

/** GET/HEAD that explicitly accepts text/html (same rule as mcp-use's isHtmlNavigationRequest). */
export function isHtmlNavigation(request: Request): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  return (request.headers.get("accept") ?? "").split(",").some((part) => {
    const [type, ...params] = part.trim().toLowerCase().split(";");
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    return type === "text/html" && (q === undefined || Number(q.slice(2)) > 0);
  });
}

export function isMcpPath(pathname: string): boolean {
  return pathname === "/mcp" || pathname.startsWith("/mcp/");
}

/** Server manifest (same file the public page serves), with this deployment's URLs filled in. */
export function manifestBody(mcpUrl: string, siteUrl: string): string {
  return JSON.stringify(manifestTemplate, null, 2).replaceAll("{{MCP_URL}}", mcpUrl).replaceAll("{{SITE_URL}}", siteUrl);
}

export default {
  async fetch(request: Request, workerEnv: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);
    const page = cfg.PUBLIC_PAGE_URL || "https://dispatch.tatinc.us/";
    // A person opening the endpoint in a browser gets the real public page, not the framework's generic landing page
    // (which links scripts and a favicon this Worker deliberately does not serve). MCP clients never send Accept: text/html.
    if (pathname === "/mcp" && isHtmlNavigation(request)) return withHeaders(Response.redirect(page, 302), true);
    if (isMcpPath(pathname)) return withHeaders(await server.fetch(request, workerEnv as never, ctx as never), false);
    if ((pathname === "/mcp.json" || pathname === "/.well-known/mcp.json") && (request.method === "GET" || request.method === "HEAD")) {
      const site = page.replace(/\/+$/, "");
      return withHeaders(new Response(manifestBody(`https://${new URL(request.url).hostname}/mcp`, site), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300", "access-control-allow-origin": "*" } }), true);
    }
    if (pathname === "/" && (request.method === "GET" || request.method === "HEAD")) {
      const body = { name: "Indexing Dispatch MCP server", mcpEndpoint: `https://${new URL(request.url).hostname}/mcp`, about: page, tools: ["audit-site", "submit-brave-url", "render-submission-canvas"] };
      return withHeaders(Response.json(body, { headers: { "cache-control": "no-store" } }), true);
    }
    return withHeaders(new Response("not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } }), true);
  },
} satisfies ExportedHandler<WorkerEnv>;
