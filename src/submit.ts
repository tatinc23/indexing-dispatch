import puppeteer, { type Browser } from "puppeteer";
import { DEFAULT_TIMINGS, runBraveSubmission, type BrowserLike, type CoreSubmitOptions, type SubmitOutcome } from "./submit-core.js";

export { BRAVE_SUBMIT_URL, DEFAULT_TIMINGS, type SubmitOutcome, type Timings } from "./submit-core.js";

export interface SubmitOptions extends Partial<Pick<CoreSubmitOptions, "submitPageUrl" | "timings" | "onSnapshot">> {
  /** Test seam: supply a browser. Defaults to a sandboxed headless Chromium. */
  launch?: () => Promise<Browser>;
}

/**
 * Sandboxed by default. `--no-sandbox` is opt-in only (BRAVE_SUBMITTER_NO_SANDBOX=1) for
 * container runtimes that cannot create user namespaces; see README for the tradeoff.
 */
export function defaultLaunch(launchMs: number = DEFAULT_TIMINGS.launchMs): Promise<Browser> {
  const noSandbox = process.env.BRAVE_SUBMITTER_NO_SANDBOX === "1";
  return puppeteer.launch({
    headless: true,
    timeout: launchMs,
    // /dev/shm is tiny in most containers; this does not weaken the sandbox.
    args: ["--disable-dev-shm-usage", ...(noSandbox ? ["--no-sandbox"] : [])],
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

/** Node entry: the shared flow (src/submit-core.ts) on a local Chromium. */
export function submitToBrave(targetUrl: string, options: SubmitOptions = {}): Promise<SubmitOutcome> {
  const launchMs = options.timings?.launchMs ?? DEFAULT_TIMINGS.launchMs;
  return runBraveSubmission(targetUrl, {
    ...(options.submitPageUrl ? { submitPageUrl: options.submitPageUrl } : {}),
    ...(options.timings ? { timings: options.timings } : {}),
    ...(options.onSnapshot ? { onSnapshot: options.onSnapshot } : {}),
    launch: async () => (await (options.launch ?? (() => defaultLaunch(launchMs)))()) as unknown as BrowserLike,
    close: (b) => closeBrowser(b as unknown as Browser),
    launchFailureHint: (e) =>
      /sandbox/i.test(String(e)) ? " Chromium's sandbox could not start in this environment; BRAVE_SUBMITTER_NO_SANDBOX=1 is an explicit opt-in (see README)." : "",
  });
}
