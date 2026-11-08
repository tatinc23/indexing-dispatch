// submit-viesearch-url on Cloudflare Browser Run: the shared flow (src/submit-core.ts) driven by @cloudflare/puppeteer.
// Same shape as src/worker/brave-browser-run.ts: the visitor's contact email is filled into Viesearch's
// Email Address field, redacted from every page-derived string, screenshots skipped, never logged.
import puppeteer from "@cloudflare/puppeteer";
import { VIESEARCH_CONFIRM_LINE } from "../contract.js";
import type { SubmitResult } from "../schema.js";
import { FIND_EMAIL_INPUT, READ_VIESEARCH_SNAPSHOT } from "../page-scripts.js";
import { DEFAULT_TIMINGS, runBraveSubmission, type BrowserLike, type SubmitOutcome, type Timings } from "../submit-core.js";
import { VIESEARCH_SUBMIT_URL } from "../viesearch.js";

/** Browser Run launches in under a second, so the launch budget is far smaller than on a 1-CPU container. */
export const BROWSER_RUN_TIMINGS: Timings = { ...DEFAULT_TIMINGS, launchMs: 15_000, totalBudgetMs: 75_000 };

/** Close the session; never throw and never wait more than 5 s (the session also ends on its own after keep_alive). */
async function closeSession(browser: BrowserLike): Promise<void> {
  const b = browser as unknown as { close(): Promise<void> };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([b.close(), new Promise<void>((resolve) => (timer = setTimeout(resolve, 5_000)))]);
  } catch {
    /* session already gone */
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface ViesearchBrowserRunDeps {
  /** Test seam: replaces puppeteer.limits / puppeteer.launch. */
  limits?: () => Promise<{ allowedBrowserAcquisitions: number; timeUntilNextAllowedBrowserAcquisition: number }>;
  launch?: () => Promise<BrowserLike>;
  timings?: Partial<Timings>;
  /** Test seam only (local fixture page). The Worker never passes it. */
  submitPageUrl?: string;
}

/** `binding` is the Worker's Browser Run binding (a Fetcher); typed loosely so Node tests can import this module. */
export async function submitViaViesearchRun(
  targetUrl: string,
  contactEmail: string,
  binding: object,
  deps: ViesearchBrowserRunDeps = {},
): Promise<SubmitOutcome> {
  const started = Date.now();
  // Ask the platform first, so a launch that would be refused costs nothing and is reported plainly.
  try {
    const lim = await (deps.limits ?? (() => puppeteer.limits(binding as never)))();
    if (lim.allowedBrowserAcquisitions < 1 || lim.timeUntilNextAllowedBrowserAcquisition > 0) {
      const wait = Math.max(1, Math.ceil(lim.timeUntilNextAllowedBrowserAcquisition / 1000));
      const result: SubmitResult = {
        targetUrl,
        status: "error",
        errorCode: "busy",
        message: `Cloudflare's browser service is not handing out a new browser right now (it allows ${lim.allowedBrowserAcquisitions} more now; next one in about ${wait} s). Nothing was sent to Viesearch.`,
        retryAfterSeconds: wait,
        durationMs: Date.now() - started,
      };
      return { result, clicked: false, browserMs: 0 };
    }
  } catch {
    // limits() is advisory; launch() below reports any real refusal.
  }
  return runBraveSubmission(targetUrl, {
    timings: { ...BROWSER_RUN_TIMINGS, ...deps.timings },
    ...(deps.submitPageUrl ? { submitPageUrl: deps.submitPageUrl } : {}),
    site: {
      label: "Viesearch",
      manualUrl: VIESEARCH_SUBMIT_URL,
      submitPageUrl: VIESEARCH_SUBMIT_URL,
      receivedNote: `Acceptance means the URL was received; it is not a guarantee that Viesearch will list it. ${VIESEARCH_CONFIRM_LINE}`,
      classifyOptions: { siteLabel: "Viesearch", rejectedPatterns: [/already a registered user/i] },
      snapshotScript: READ_VIESEARCH_SNAPSHOT,
    },
    extraFields: [{ script: FIND_EMAIL_INPUT, value: contactEmail, label: "email" }],
    redact: [contactEmail.trim()],
    screenshots: false,
    // keep_alive 60 s is the default idle timeout; the session is closed explicitly when the flow ends.
    launch: deps.launch ?? (async () => (await puppeteer.launch(binding as never, { keep_alive: 60_000 })) as unknown as BrowserLike),
    close: closeSession,
    launchFailureHint: (e) => (/429|limit|quota|exceeded/i.test(String(e)) ? " Cloudflare's browser service refused a new browser (daily or concurrency limit); nothing was sent to Viesearch." : ""),
  });
}
