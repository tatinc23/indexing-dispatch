// Result contracts for the discovery suite. Backend tools return these; the widget renders them.
// Every field must come from something actually observed. No simulated or default-filled values.
import { z } from "zod";

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

export const indexNowEngine = z.object({
  engine: z.string(), // as documented by the protocol, e.g. "api.indexnow.org"
  endpoint: z.string(),
  ok: z.boolean(),
  httpStatus: z.number().optional(),
  message: z.string(),
});

export const indexNowResultSchema = z.object({
  status: z.enum(["submitted", "key_not_verified", "rejected", "blocked", "error"]),
  host: z.string(),
  urlCount: z.number(),
  keyLocation: z.string(),
  keyVerified: z.boolean(), // we fetched keyLocation and its body matched the key BEFORE pinging
  engines: z.array(indexNowEngine),
  message: z.string(),
  durationMs: z.number(),
});
export type IndexNowResult = z.infer<typeof indexNowResultSchema>;

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
});
export type CanvasProps = z.infer<typeof canvasPropsSchema>;
