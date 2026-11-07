import type { Browser } from "puppeteer";
import { FIND_EMAIL_INPUT, READ_VIESEARCH_SNAPSHOT } from "./page-scripts.js";
import { DEFAULT_TIMINGS, runBraveSubmission, type BrowserLike, type CoreSubmitOptions, type SubmitOutcome } from "./submit-core.js";
import { defaultLaunch } from "./submit.js";

export { DEFAULT_TIMINGS, type SubmitOutcome, type Timings } from "./submit-core.js";

/** Viesearch's public submit form. One URL and one contact email per submission; the rest stays blank. */
export const VIESEARCH_SUBMIT_URL = "https://viesearch.com/submit";

/** "already a registered user" on the page means Viesearch refused this URL: map it to `rejected`. */
const REGISTERED_USER = /already a registered user/i;

export interface ViesearchSubmitOptions extends Partial<Pick<CoreSubmitOptions, "submitPageUrl" | "timings" | "onSnapshot">> {
  /** Test seam: supply a browser. Defaults to a sandboxed headless Chromium. */
  launch?: () => Promise<Browser>;
}

/**
 * Node entry: the shared flow (src/submit-core.ts) on a local Chromium, filling Viesearch's
 * Website URL and Email Address fields. The contact email is redacted from every page-derived
 * string in the result, screenshots are skipped (the filled form would show it), and the email
 * is never logged.
 */
export function submitToViesearch(targetUrl: string, contactEmail: string, options: ViesearchSubmitOptions = {}): Promise<SubmitOutcome> {
  const launchMs = options.timings?.launchMs ?? DEFAULT_TIMINGS.launchMs;
  return runBraveSubmission(targetUrl, {
    ...(options.submitPageUrl ? { submitPageUrl: options.submitPageUrl } : {}),
    ...(options.timings ? { timings: options.timings } : {}),
    ...(options.onSnapshot ? { onSnapshot: options.onSnapshot } : {}),
    site: {
      label: "Viesearch",
      manualUrl: VIESEARCH_SUBMIT_URL,
      receivedNote: "Acceptance means the URL was received; it is not a guarantee that Viesearch will list it.",
      classifyOptions: { siteLabel: "Viesearch", rejectedPatterns: [REGISTERED_USER] },
      snapshotScript: READ_VIESEARCH_SNAPSHOT,
    },
    extraFields: [{ script: FIND_EMAIL_INPUT, value: contactEmail, label: "email" }],
    redact: [contactEmail.trim()],
    screenshots: false,
    launch: async () => (await (options.launch ?? (() => defaultLaunch(launchMs)))()) as unknown as BrowserLike,
    close: (b) => closeBrowser(b as unknown as Browser),
    launchFailureHint: (e) =>
      /sandbox/i.test(String(e)) ? " Chromium's sandbox could not start in this environment; BRAVE_SUBMITTER_NO_SANDBOX=1 is an explicit opt-in (see README)." : "",
  });
}

async function closeBrowser(browser: Browser): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      browser.close(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("browser.close timed out")), 5_000);
      }),
    ]);
  } catch {
    try {
      browser.process()?.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}
