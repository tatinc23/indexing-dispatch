import { z } from "zod";

export const MAX_URL_LENGTH = 2048;

/** Hostnames/IPs Brave could never crawl: reject early instead of spending a browser run. */
function isNonPublicHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan")) return true;

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }

  if (host.startsWith("[")) {
    const v6 = host.slice(1, -1);
    return v6 === "::1" || v6 === "::" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith("::ffff:");
  }

  // A single-label hostname (no dot) is never a public website.
  return !host.includes(".");
}

/** Returns a human-readable problem with the URL, or null when it is acceptable. */
export function urlProblem(value: string): string | null {
  if (/\s/.test(value)) return "must not contain whitespace";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "must be an absolute URL such as https://example.com/";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "must use http or https";
  if (url.username || url.password) return "must not contain embedded username or password";
  if (!url.hostname) return "must include a hostname";
  if (isNonPublicHost(url.hostname)) return "must point at a publicly reachable host";
  return null;
}

export const targetUrlSchema = z
  .string()
  .trim()
  .min(1, "targetUrl is required")
  .max(MAX_URL_LENGTH, `targetUrl must be at most ${MAX_URL_LENGTH} characters`)
  .superRefine((value, ctx) => {
    const problem = urlProblem(value);
    if (problem) ctx.addIssue({ code: "custom", message: `targetUrl ${problem}` });
  });

export const inputSchema = z.object({
  targetUrl: targetUrlSchema.describe(
    "Absolute http(s) URL to submit to Brave Search for (re-)fetching, e.g. https://example.com/. No credentials in the URL; must be publicly reachable.",
  ),
});

export const STATUSES = ["accepted", "rejected", "verification_required", "timeout", "error"] as const;
export const ERROR_CODES = [
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
] as const;

export type Status = (typeof STATUSES)[number];
export type ErrorCode = (typeof ERROR_CODES)[number];

export const diagnosticsSchema = z.object({
  finalUrl: z.string().optional().describe("Page URL at the end of the run, with query string and fragment removed."),
  observed: z.array(z.string()).describe("Compact timeline of distinct page states seen after clicking Submit."),
  domExcerpt: z.string().optional().describe("Sanitized, truncated visible text of the page at the end of the run."),
  screenshotAttached: z.boolean().describe("True when a JPEG screenshot is attached as an image content block."),
});

export const resultSchema = z.object({
  targetUrl: z.string().describe("The URL this call was asked to submit."),
  status: z
    .enum(STATUSES)
    .describe(
      "accepted = Brave's page showed an explicit success confirmation; rejected = explicit error shown; verification_required = a human challenge persisted; timeout = no definitive state before the deadline; error = the run could not be completed.",
    ),
  message: z.string().describe("What actually happened, in plain words."),
  confirmationText: z.string().optional().describe("Verbatim confirmation text observed on Brave's page (accepted only)."),
  errorCode: z.enum(ERROR_CODES).optional().describe("Machine-readable reason when status is error."),
  retryAfterSeconds: z.number().int().positive().optional().describe("Earliest sensible retry, for local limit responses."),
  durationMs: z.number().int().nonnegative().describe("Wall-clock time spent on this call."),
  diagnostics: diagnosticsSchema.optional().describe("Present when status is not accepted."),
});

export type SubmitResult = z.infer<typeof resultSchema>;
export type Diagnostics = z.infer<typeof diagnosticsSchema>;
