// Tool and server metadata shared by the Node entry (index.ts) and the Cloudflare Workers entry (src/worker/index.ts),
// so names, descriptions, schemas and annotations cannot drift between the two hosts.
import { z } from "zod";
import { auditResultSchema, canvasPropsSchema, indexNowResultSchema, type AuditResult, type IndexNowResult } from "./contract.js";
import { inputSchema, resultSchema, type SubmitResult } from "./schema.js";

/** ChatGPT status labels shown while a tool runs / after it finishes (OpenAI limits each to 64 characters).
 *  Both spellings are emitted: the flat keys OpenAI documents and the object form the Manufact checker describes. */
export function toolInvocationMeta(invoking: string, invoked: string) {
  return {
    "openai/toolInvocation/invoking": invoking,
    "openai/toolInvocation/invoked": invoked,
    "openai/toolInvocation": { invoking, invoked },
  } as const;
}

/* The canvas view declares NO ui.domain (2026-11-06). Claude accepts only {sha256(connector URL)[:32]}.claudemcpcontent.com
 * and showed "Couldn't load this widget" for "https://dispatch-mcp.tatinc.us". mcp-use 2.11.2 did not swap the value for
 * a Claude-named client on the Worker, and its swap hashes the authored string, not the connector URL. Without a domain
 * every host uses its default sandbox origin (MCP Apps spec: the field is optional). See DECISIONS.md 2026-11-06. */

export const SERVER_INFO = {
  name: "indexing-dispatch",
  title: "Indexing Dispatch",
  version: "1.0.0",
  description: "Claude is said to search the web with Brave.\nSend Brave your link, audit your site for AI, ping IndexNow. See what each one really said.",
  instructions:
    "Run audit-site first (read-only). Use submit-brave-url for one public http(s) URL at a time and check `status`: only `accepted` means Brave showed an explicit confirmation. Use submit-indexnow only when the user has already hosted their IndexNow key file at the site root; it checks the key file first and sends one request. Open render-submission-canvas when the user wants to review or run things visually. Accepted does not mean indexed. Never call any submit tool in a loop or retry after a refusal, rate limit or timeout without checking with the user. snapshot-cloudflare-baseline is listed only on servers whose operator set a Cloudflare token. Limits are per server instance and in memory.",
  websiteUrl: "https://dispatch.tatinc.us",
  icons: [{ src: "icon.svg", mimeType: "image/svg+xml", sizes: ["512x512"] }],
} as const;

export const submitBraveUrlDef = {
    name: "submit-brave-url",
    title: "Submit URL to Brave Search",
    description:
      "Submit one public http(s) URL to https://search.brave.com/submit-url using a real headless browser, then report what Brave's page actually showed. status=accepted only when an explicit success confirmation was observed; acceptance is not a guarantee of indexing. Takes up to ~80 seconds (typically 10-40). Never retry in a loop.",
    inputSchema,
    outputSchema: resultSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    _meta: toolInvocationMeta("Sending your link to Brave...", "Brave answered"),
} as const;

export const submitIndexnowDef = {
    name: "submit-indexnow",
    title: "Submit URLs via IndexNow",
    description:
      "Tell IndexNow (Bing, Yandex, Naver and other participating engines; one request is shared with all of them) that pages on one host are new or changed. First fetches the key file you host and sends nothing unless it contains exactly your key; the pages must sit on that host under the key file's folder. Sends one request and never retries. Read `status`: only `submitted` means IndexNow accepted the request, and a submission asks engines to crawl; it does not guarantee indexing. You must create and host your own key file; no key is built in.",
    inputSchema: z.object({
      host: z.string().trim().min(1).max(253).describe("Exact host the URLs belong to, e.g. www.example.com (no scheme or path). Subdomains are separate hosts."),
      key: z.string().trim().min(1).max(256).describe("Your IndexNow key, exactly as written inside the key file you host on this site. The key file is checked against it before anything is sent."),
      urls: z.array(z.string().max(2048)).min(1).max(100).describe("Full addresses of the new or changed pages, all on `host` and under the key file's folder (the whole site when the key file is at the site root)."),
      keyLocation: z.string().trim().max(2048).optional().describe("Full address of your key file. Leave it out when the file is at https://<host>/<key>.txt, which is the default."),
    }),
    outputSchema: indexNowResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    _meta: toolInvocationMeta("Pinging IndexNow...", "IndexNow answered"),
} as const;

export const auditSiteDef = {
    name: "audit-site",
    title: "Audit a page for search and AI readiness",
    description:
      "Read-only check of one public http(s) page: title, meta description, canonical, language, structured data, Open Graph, plus the site's robots.txt rules for AI and search crawlers, llms.txt and sitemap. Reports only what was fetched and drafts suggested files (llms.txt, JSON-LD, robots.txt lines) from facts found on the page. A PageSpeed result is included only if the server operator configured a Google PageSpeed key; otherwise it is reported as skipped. Private and internal addresses are refused. Results are observed, not guaranteed to change rankings.",
    inputSchema: z.object({
      targetUrl: z.string().trim().min(1).max(2048).describe("Absolute public http(s) URL of the page to audit, e.g. https://example.com/."),
      strategy: z.enum(["mobile", "desktop"]).optional().describe("PageSpeed form factor when PageSpeed is configured. Default mobile."),
    }),
    outputSchema: auditResultSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    _meta: toolInvocationMeta("Checking your site...", "Site checked"),
} as const;

export const renderSubmissionCanvasDef = {
    name: "render-submission-canvas",
    title: "Open the submission canvas",
    description:
      "Opens the Indexing Dispatch panel (an interactive MCP App view) inside the chat. In the panel the person enters or reviews page URLs, chooses which tools to run (Brave submission, site audit, IndexNow, plus PageSpeed only when this server has a key), presses Initiate run, and copies the results. Opening the panel sends nothing and checks nothing: the panel calls the other tools only when the person presses run. Needs a host that can show MCP App views; other hosts show only the short text reply. The reply echoes the panel's starting settings.",
    inputSchema: z.object({
      urls: z.array(z.string()).optional().describe("Page URLs to pre-fill in the panel's URL box, one per line (for example https://example.com/new-page). Optional; the person can edit or add URLs in the panel."),
      domain: z.string().optional().describe("A site address such as example.com, used only when `urls` is empty: the box is pre-filled with https://<domain>/. Optional."),
      mode: z.enum(["interactive", "autonomous"]).optional().describe("Defaults to interactive. `autonomous` only shows a note that it was requested; the panel still waits for the person to press Initiate run."),
    }),
    outputSchema: canvasPropsSchema,
    view: { name: "render-submission-canvas", description: "Submission canvas" },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: toolInvocationMeta("Opening the panel...", "Panel ready"),
} as const;

/** Refusal results: nothing was sent. Shared wording for both hosts. */
export function braveDenied(targetUrl: string, gate: { code: "busy" | "rate_limited" | "recently_submitted"; message: string; retryAfterSeconds: number }): SubmitResult {
  return { targetUrl, status: "error", errorCode: gate.code, message: gate.message, retryAfterSeconds: gate.retryAfterSeconds, durationMs: 0 };
}

export function indexNowDenied(host: string, urlCount: number, keyLocation: string, gate: { message: string; retryAfterSeconds: number }): IndexNowResult {
  return { status: "error", host: host.toLowerCase(), urlCount, keyLocation, keyVerified: false, engines: [], message: `${gate.message} Retry after about ${gate.retryAfterSeconds} seconds. Nothing was sent.`, durationMs: 0 };
}

export function auditDenied(targetUrl: string, gate: { message: string; retryAfterSeconds: number }): AuditResult {
  return { status: "error", targetUrl, message: `${gate.message} Retry after about ${gate.retryAfterSeconds} seconds.`, findings: [], suggestedFiles: [], durationMs: 0 };
}

export const defaultKeyLocation = (host: string, key: string) => `https://${host.toLowerCase()}/${key}.txt`;
