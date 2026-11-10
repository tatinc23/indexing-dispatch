// Tool and server metadata shared by the Node entry (index.ts) and the Cloudflare Workers entry (src/worker/index.ts),
// so names, descriptions, schemas and annotations cannot drift between the two hosts.
import { z } from "zod";
import { auditResultSchema, canvasPropsSchema, viesearchResultSchema, type AuditResult, type ViesearchResult } from "./contract.js";
import { inputSchema, resultSchema, targetUrlSchema, type SubmitResult } from "./schema.js";

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
  description: "Claude is said to search the web with Brave.\nSend your page to Brave Search and Viesearch from your AI app. You get their receipt: 'received', not 'indexed'.",
  instructions:
    "Use when the user asks to submit/send/add their site to Brave or Viesearch, or to check/audit their site. Run audit-site first (read-only). Use submit-brave-url for one public http(s) URL at a time and check `status`: only `accepted` means Brave showed an explicit confirmation, which is a receipt that Brave received the URL, not that it is indexed. Use submit-viesearch-url with the user's own contact email address; it fills Viesearch's form and sends one request, and the email is never stored or echoed. If the user gives no URL, ask for it and never guess; for Viesearch also ask for their contact email and never invent one. Every Viesearch result reminds the user to confirm the email: Viesearch emails a Confirm Submission step and the site enters their review queue only after that. Open render-submission-canvas when the user wants to review or run things visually. Never call any submit tool in a loop or retry after a refusal, rate limit or timeout without checking with the user. snapshot-cloudflare-baseline is listed only on servers whose operator set a Cloudflare token. Limits are per server instance and in memory.",
  websiteUrl: "https://dispatch.tatinc.us",
  icons: [{ src: "icon.svg", mimeType: "image/svg+xml", sizes: ["512x512"] }],
} as const;

export const submitBraveUrlDef = {
    name: "submit-brave-url",
    title: "Submit URL to Brave Search",
    description:
      "Use when the user asks to submit/send/add their site to Brave. Submit one public http(s) URL to https://search.brave.com/submit-url using a real headless browser, then report what Brave's page actually showed. Bare domains work (example.com becomes https://example.com/). If the user gives no URL, ask for it and never guess. status=accepted only when an explicit success confirmation was observed; acceptance is not a guarantee of indexing. Takes up to ~80 seconds (typically 10-40). Never retry in a loop.",
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

export const auditSiteDef = {
    name: "audit-site",
    title: "Audit a page for search and AI readiness",
    description:
      "Use when the user asks to check/audit their site. Read-only check of one public http(s) page: title, meta description, canonical, language, structured data, Open Graph, plus the site's robots.txt rules for AI and search crawlers, llms.txt and sitemap. Bare domains work (example.com becomes https://example.com/). If the user gives no URL, ask for it and never guess. Reports only what was fetched and drafts suggested files (llms.txt, JSON-LD, robots.txt lines) from facts found on the page. A PageSpeed result is included only if the server operator configured a Google PageSpeed key; otherwise it is reported as skipped. Private and internal addresses are refused. Results are observed, not guaranteed to change rankings.",
    inputSchema: z.object({
      targetUrl: targetUrlSchema.describe("Absolute public http(s) URL of the page to audit, e.g. https://example.com/. Bare domains work and become https://."),
      strategy: z.enum(["mobile", "desktop"]).optional().describe("PageSpeed form factor when PageSpeed is configured. Default mobile."),
    }),
    outputSchema: auditResultSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    _meta: toolInvocationMeta("Checking your site...", "Site checked"),
} as const;

export const submitViesearchUrlDef = {
    name: "submit-viesearch-url",
    title: "Submit URL to Viesearch",
    description:
      "Use when the user asks to submit/send/add their site to Viesearch. Submit one public http(s) URL to https://viesearch.com/submit, the human-reviewed web directory. Bare domains work (example.com becomes https://example.com/). Fills Viesearch's Website URL field with the URL and its Email Address field with the user's own contact email, leaves every other field blank, clicks Submit once, and reports what Viesearch showed. If the user gives no URL, ask for it and never guess; ask for their contact email and never invent one. The contact email goes only to Viesearch with the submission: it is never stored, logged, or echoed back. Read `status`: only `accepted` means Viesearch showed an explicit success confirmation, and a listing still needs a human review. Every result reminds the user to check their inbox for Viesearch's Confirm Submission email: their site enters the review queue only after they click it. A CAPTCHA or other human-verification step stops the run as `verification_required` and is never solved; 'already a registered user' maps to `rejected`. Never retry without the user; one URL per call.",
    inputSchema: z.object({
      targetUrl: targetUrlSchema,
      contactEmail: z.string().trim().min(3).max(254).email("Provide the user's own contact email address as one string.").describe("The user's own contact email address, typed into Viesearch's Email Address field. Never stored, never logged, never echoed back."),
    }),
    outputSchema: viesearchResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    _meta: toolInvocationMeta("Submitting to Viesearch...", "Viesearch answered"),
} as const;

export const renderSubmissionCanvasDef = {
    name: "render-submission-canvas",
    title: "Open the submission canvas",
    description:
      "Opens the Indexing Dispatch panel (an interactive MCP App view) inside the chat. Use when the person asks to open the panel or form, e.g. 'open the submission panel for example.com, my email is me@example.com': pass the site in `urls` (bare domains are fine) and their email in `email`. In the panel the person enters or reviews page URLs and (for Viesearch) their contact email, chooses which tools to run (Brave submission, Viesearch submission, site audit, plus PageSpeed only when this server has a key), presses Initiate run, and copies the results. Opening the panel sends nothing and checks nothing: the panel calls the other tools only when the person presses run. Needs a host that can show MCP App views; other hosts show only the short text reply. The reply echoes the panel's starting settings.",
    inputSchema: z.object({
      urls: z.array(z.string()).optional().describe("Page URLs to pre-fill in the panel's URL box, one per line (for example https://example.com/new-page). Optional; the person can edit or add URLs in the panel."),
      domain: z.string().optional().describe("A site address such as example.com, used only when `urls` is empty: the box is pre-filled with https://<domain>/. Optional."),
      mode: z.enum(["interactive", "autonomous"]).optional().describe("Defaults to interactive. `autonomous` only shows a note that it was requested; the panel still waits for the person to press Initiate run."),
      email: z.string().trim().max(254).optional().describe("The person's own contact email for Viesearch, to pre-fill the panel's email box. Pass it only when the person gave it in this chat; never invent one. Nothing is sent until they press Initiate run."),
    }),
    outputSchema: canvasPropsSchema,
    view: { name: "render-submission-canvas", description: "Submission canvas" },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: toolInvocationMeta("Opening the panel...", "Panel ready"),
} as const;

export const submitMySitePromptDef = {
  name: "submit-my-site",
  title: "Submit my site to Brave (and Viesearch)",
  description: "Use when the user says 'submit my site to Brave' (or 'to Brave and Viesearch', 'check my site'). Runs audit-site, then submit-brave-url, then submit-viesearch-url when an email is given. Reports each receipt word for word and never retries.",
} as const;

export const checkMySitePromptDef = {
  name: "check-my-site",
  title: "Check my site for search and AI readiness",
  description: "Use when the user says 'check my site'. Runs audit-site only (read-only) and summarizes what it found.",
} as const;

export const submitMySitePromptSchema = z.object({
  url: z.string().trim().min(1).max(2048).describe("The site or page to submit, e.g. https://example.com/. Bare domains work and become https://. If missing, ask the user and never guess."),
  email: z.string().trim().max(254).optional().describe("The user's own contact email for Viesearch. If missing, ask the user and never invent one; skip the Viesearch step when none is given."),
});

export const checkMySitePromptSchema = z.object({
  url: z.string().trim().min(1).max(2048).describe("The site or page to audit, e.g. https://example.com/. Bare domains work and become https://. If missing, ask the user and never guess."),
});

export function submitMySitePromptText(url: string, email?: string): string {
  const lines = [
    `Please check my website, then send its main page to Brave Search${email ? " and Viesearch" : ""}.`,
    "",
    "Use the indexing-dispatch tools. My page is:",
    "",
    url,
    "",
  ];
  if (email) {
    lines.push("My contact email for Viesearch is:", "", email, "", "My email goes only to Viesearch with the submission.");
  } else {
    lines.push("I have no Viesearch email to give: skip the Viesearch step.");
  }
  lines.push(
    "",
    "Do these in order:",
    "1. Call the tool audit-site once with targetUrl set to my page. It only reads; it changes nothing.",
    "2. Summarise what it found, and list any drafted files it returned (llms.txt, JSON-LD, robots.txt lines) so I can review them. Say they are drafts.",
    "3. Then call the tool submit-brave-url one time with the same page. It usually takes 10 to 40 seconds. Wait for the result.",
  );
  if (email) {
    lines.push("4. Then call the tool submit-viesearch-url one time with the same page and my email as contactEmail.");
  }
  lines.push(
    "",
    "Rules:",
    "- Report each tool's status and message word for word. If any tool returns an errorCode or retryAfterSeconds, include them.",
    "- \"accepted\" means that site confirmed it got the URL. It doesn't mean the page is indexed or listed. Never say or imply it is, or will be.",
    "- Don't retry any tool, even if it fails or times out. If a result says to stop, stop.",
    "- If a result says verification_required, tell me to finish that one by hand instead: Brave at https://search.brave.com/submit-url, Viesearch at https://viesearch.com/submit.",
  );
  if (email) {
    lines.push("- For Viesearch, remind me to check my inbox for their Confirm Submission email: my site enters their review queue only after I click it.");
  }
  lines.push("- If you don't have a tool I asked for, tell me which one is missing and stop. Don't say you ran anything you didn't.");
  return lines.join("\n");
}

export function checkMySitePromptText(url: string): string {
  return [
    "Please check my website for search and AI readiness.",
    "",
    "Use the indexing-dispatch tool audit-site once with targetUrl set to:",
    "",
    url,
    "",
    "It only reads; it changes nothing. Summarise what it found, and list any drafted files it returned (llms.txt, JSON-LD, robots.txt lines) so I can review them. Say they are drafts.",
    "Report its status and message word for word. Don't retry, even if it fails or times out.",
  ].join("\n");
}

/** Refusal results: nothing was sent. Shared wording for both hosts. */
export function braveDenied(targetUrl: string, gate: { code: "busy" | "rate_limited" | "recently_submitted"; message: string; retryAfterSeconds: number }): SubmitResult {
  return { targetUrl, status: "error", errorCode: gate.code, message: gate.message, retryAfterSeconds: gate.retryAfterSeconds, durationMs: 0 };
}

export function viesearchDenied(targetUrl: string, gate: { code: "busy" | "rate_limited" | "recently_submitted"; message: string; retryAfterSeconds: number }): ViesearchResult {
  return { targetUrl, status: "error", errorCode: gate.code, message: gate.message, retryAfterSeconds: gate.retryAfterSeconds, durationMs: 0 };
}

export function auditDenied(targetUrl: string, gate: { message: string; retryAfterSeconds: number }): AuditResult {
  return { status: "error", targetUrl, message: `${gate.message} Retry after about ${gate.retryAfterSeconds} seconds.`, findings: [], suggestedFiles: [], durationMs: 0 };
}



/** Light shape check before pre-filling the panel's email box; the panel and the Viesearch tool validate again. */
export function plausibleEmail(v: string | undefined): boolean {
  return typeof v === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.trim()) && v.trim().length <= 254;
}
