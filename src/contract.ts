// Result contracts for the discovery suite. Backend tools return these; the widget renders them.
// Every field must come from something actually observed. No simulated or default-filled values.
import { z } from "zod";

/**
 * Viesearch email-confirmation reminder (2026-11-08, the maintainer's first real run): the tool reported
 * "no clear answer", then Viesearch emailed "Confirm your Viesearch submission" with a
 * "Confirm Submission" button ("Your site enters their review queue only after that").
 * Until Viesearch's post-submit page wording is observed, "accepted" still needs an explicit
 * on-page confirmation, and EVERY Viesearch result carries this reminder (text, structured
 * message and panel row). Single source: backend (discovery-format), widget (canvas lib)
 * and prompts all use this exact sentence.
 */
export const VIESEARCH_CONFIRM_LINE =
  "Check your inbox for an email from Viesearch and click Confirm Submission. Your site enters their review queue only after that.";

export const severity = z.enum(["info", "warn", "missing"]);

export const finding = z.object({
  id: z.string(), // stable key, e.g. "llms-txt-missing"
  severity,
  message: z.string(),
});

export const suggestedFile = z.object({
  path: z.string(), // e.g. "/llms.txt", "head:ld+json", "/robots.txt (append)"
  kind: z.enum(["llms.txt", "json-ld", "robots.txt"]),
  content: z.string(), // drafted only from facts observed on the page (title, description, URL)
});

const botRule = z.enum(["allowed", "blocked", "unspecified"]);

export const auditResultSchema = z.object({
  status: z.enum(["ok", "unreachable", "blocked", "error"]), // blocked = refused by our SSRF guard
  targetUrl: z.string(),
  finalUrl: z.string().optional(),
  httpStatus: z.number().optional(),
  message: z.string(),
  page: z
    .object({
      title: z.string().optional(),
      description: z.string().optional(),
      canonical: z.string().optional(),
      lang: z.string().optional(),
      jsonLdTypes: z.array(z.string()),
      hasOpenGraph: z.boolean(),
      bytes: z.number(),
    })
    .optional(),
  aiReadiness: z
    .object({
      llmsTxt: z.object({ present: z.boolean(), url: z.string(), bytes: z.number().optional() }),
      robotsTxt: z.object({
        present: z.boolean(),
        url: z.string(),
        aiBots: z.record(z.string(), botRule), // GPTBot, OAI-SearchBot, ClaudeBot, PerplexityBot, Bravebot, Googlebot, Bingbot
      }),
      sitemap: z.object({ present: z.boolean(), url: z.string().optional() }),
    })
    .optional(),
  pageSpeed: z
    .object({
      status: z.enum(["ok", "skipped", "error"]),
      reason: z.string().optional(), // why skipped/error, e.g. "PAGESPEED_API_KEY not set"
      strategy: z.enum(["mobile", "desktop"]).optional(),
      performanceScore: z.number().optional(),
      seoScore: z.number().optional(),
      lcpMs: z.number().optional(),
      cls: z.number().optional(),
      tbtMs: z.number().optional(),
      ttfbMs: z.number().optional(),
    })
    .optional(),
  findings: z.array(finding),
  suggestedFiles: z.array(suggestedFile),
  durationMs: z.number(),
});
export type AuditResult = z.infer<typeof auditResultSchema>;

export const viesearchResultSchema = z.object({
  targetUrl: z.string().describe("The URL that was submitted, exactly as given."),
  status: z
    .enum(["accepted", "rejected", "verification_required", "timeout", "error"])
    .describe(
      "Outcome. accepted = Viesearch's page showed an explicit success confirmation. rejected = Viesearch refused it (e.g. 'already a registered user'). verification_required = Viesearch is showing a CAPTCHA or other human check this server will not solve; finish by hand. timeout = submitted but no verdict arrived before the deadline. error = the run failed before submitting (limit, browser failure, unexpected page).",
    ),
  message: z.string().describe("Plain-language account of what Viesearch showed. Report it to the user as written."),
  confirmationText: z
    .string()
    .optional()
    .describe("Exact success wording from Viesearch's page, when it showed one. Absent unless status is accepted."),
  errorCode: z
    .enum([
      "busy",
      "rate_limited",
      "recently_submitted",
      "browser_launch_failed",
      "navigation_failed",
      "http_error",
      "unexpected_navigation",
      "input_not_found",
      "input_mismatch",
      "submit_button_not_found",
      "submit_button_disabled",
      "unexpected_error",
    ])
    .optional()
    .describe("Machine-readable failure class, present only when status is error or busy/rate_limited."),
  retryAfterSeconds: z.number().optional().describe("How long to wait before trying again. Present only on busy, rate_limited or recently_submitted."),
  durationMs: z.number().describe("Time the call took, in milliseconds."),
  diagnostics: z
    .object({
      finalUrl: z.string().optional(),
      observed: z.array(z.string()),
      domExcerpt: z.string().optional(),
      screenshotAttached: z.boolean(),
    })
    .optional()
    .describe("What the page showed step by step (email redacted). Present when status is not accepted."),
});
export type ViesearchResult = z.infer<typeof viesearchResultSchema>;

export const cloudflareBaselineSchema = z.object({
  status: z.enum(["ok", "not_configured", "error"]),
  message: z.string(),
  zoneId: z.string().optional(),
  windowStart: z.string().optional(),
  windowEnd: z.string().optional(),
  totals: z.object({ requests: z.number(), bytes: z.number(), uniques: z.number().optional() }).optional(),
  aiBots: z.array(z.object({ name: z.string(), requests: z.number() })).optional(),
  // Stateless re-check: the caller passes an earlier result back as `previous`, we return the delta.
  deltaVsPrevious: z
    .object({ requests: z.number(), bytes: z.number(), aiBotRequests: z.number() })
    .optional(),
});
export type CloudflareBaseline = z.infer<typeof cloudflareBaselineSchema>;

export const canvasPropsSchema = z.object({
  initialUrls: z.array(z.string()).describe("URLs the panel's box starts with (the `urls` argument; empty when none were given)."),
  domain: z.string().optional().describe("The `domain` argument as given; the panel pre-fills https://<domain>/ from it when initialUrls is empty."),
  mode: z.enum(["interactive", "autonomous"]).describe("The mode the panel opened in. The panel waits for the person to press Initiate run in both modes."),
  enabledTools: z.object({
    cloudflare: z.boolean().describe("True only if this server offers the Cloudflare baseline tool."),
    pageSpeed: z.boolean().describe("True only if this server has a PageSpeed key, so audits include a PageSpeed result."),
  }).describe("Which optional tools this server instance really has."), // what this server instance really has
  morePlacesUrl: z.string().optional().describe("Absolute URL of the static more-places page (directories no agent can submit to)."),
  initialEmail: z.string().optional().describe("The person's own email for Viesearch, pre-filled in the panel's email box (only when they gave it)."),
});
export type CanvasProps = z.infer<typeof canvasPropsSchema>;
