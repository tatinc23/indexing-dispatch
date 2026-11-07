import { classify, sanitizeText, signature, stripUrl, type Observation, type Snapshot } from "./classify.js";
import { FIND_SUBMIT_BUTTON, FIND_URL_INPUT, READ_SNAPSHOT } from "./page-scripts.js";
import type { ClassifyOptions } from "./classify.js";
import type { Diagnostics, ErrorCode, SubmitResult } from "./schema.js";

// Runtime-neutral Brave submission flow. Drives any Puppeteer-compatible browser through the structural types below:
// the Node build passes `puppeteer` (src/submit.ts), the Workers build passes `@cloudflare/puppeteer` on Browser Run
// (src/worker/brave-browser-run.ts). The verdict logic is unchanged (src/classify.ts, in-page scripts in src/page-scripts.ts).

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface ElementLike {
  focus(): Promise<void>;
  type(text: string): Promise<void>;
  click(): Promise<void>;
  dispose(): Promise<void>;
  evaluate(fn: (el: any) => any): Promise<any>;
}
export interface HandleLike {
  asElement(): unknown;
  dispose(): Promise<void>;
}
export interface FrameLike {
  url(): string;
}
export interface PageLike {
  setViewport(v: { width: number; height: number }): Promise<unknown>;
  on(event: "framenavigated", handler: (frame: any) => void): unknown;
  mainFrame(): FrameLike;
  goto(url: string, opts: { waitUntil: "domcontentloaded"; timeout: number }): Promise<{ status(): number } | null>;
  evaluateHandle(script: string): Promise<HandleLike>;
  evaluate(script: string): Promise<unknown>;
  screenshot(opts: { type: "jpeg"; quality: number; encoding: "base64" }): Promise<unknown>;
  isClosed(): boolean;
  url(): string;
}
export interface BrowserLike {
  newPage(): Promise<PageLike>;
}

/** The only page this server ever drives. Client input never reaches this value. */
export const BRAVE_SUBMIT_URL = "https://search.brave.com/submit-url";

export interface Timings {
  /** Hard cap on the whole call, launch to close. */
  totalBudgetMs: number;
  launchMs: number;
  navigationMs: number;
  /** Waiting for the URL input to render, and for Submit to become enabled. */
  uiReadyMs: number;
  /** No verdict is issued sooner than this after clicking Submit. */
  minSettleMs: number;
  /** How long to keep watching for a definitive state after clicking. */
  observeMs: number;
  /** A human challenge must stay visible this long before it is reported. */
  challengePersistMs: number;
  pollMs: number;
}

// Sized from the Manufact container (1 CPU, ~960 MB): cold Chromium launch measured at 16 s on 2026-10-25.
export const DEFAULT_TIMINGS: Timings = {
  totalBudgetMs: 80_000,
  launchMs: 30_000,
  navigationMs: 20_000,
  uiReadyMs: 20_000,
  minSettleMs: 2_000,
  observeMs: 30_000,
  challengePersistMs: 6_000,
  pollMs: 250,
};

export interface SubmitField {
  /** In-page script resolving to the form input. */
  script: string;
  /** Exact text typed into the input (verified back after typing). */
  value: string;
  /** Human label for messages, e.g. "URL" or "email". */
  label: string;
}

export interface SiteBehavior {
  /** "Brave" | "Viesearch": used in user-facing messages. */
  label: string;
  /** Canonical submit page named in messages that send the user to finish by hand. */
  manualUrl: string;
  /** Note appended to the accepted message. Defaults to the Brave indexing note. */
  receivedNote?: string;
  /** Classify options (rejected patterns, site label) for the shared conservative classifier. */
  classifyOptions?: ClassifyOptions;
  /** In-page snapshot script. Defaults to READ_SNAPSHOT. */
  snapshotScript?: string;
}

export interface CoreSubmitOptions {
  /** Starts the browser. */
  launch: () => Promise<BrowserLike>;
  /** Closes it (runtime-specific: Node kills a stuck process, Browser Run ends the session). Must not throw. */
  close: (browser: BrowserLike) => Promise<void>;
  /** Extra hint appended to a launch failure message. */
  launchFailureHint?: (error: unknown) => string;
  /** Test seam only. The MCP tool never passes this. */
  submitPageUrl?: string;
  timings?: Partial<Timings>;
  /** Debug/test seam: called with every page snapshot taken after Submit was clicked. */
  onSnapshot?: (snap: Snapshot, elapsedMs: number) => void;
  /** Overrides the Brave defaults (labels, verdict logic, snapshot script). */
  site?: SiteBehavior;
  /** Extra fields filled and verified after the URL, in order (Viesearch passes its email field). */
  extraFields?: SubmitField[];
  /** Values scrubbed from page text in results (e.g. the visitor's contact email). */
  redact?: string[];
  /** false skips screenshots (pages that echo private input). Defaults to true. */
  screenshots?: boolean;
}

export interface SubmitOutcome {
  result: SubmitResult;
  /** Base64 JPEG, present only for non-accepted outcomes where a page existed. */
  screenshot?: string;
  /** True once Submit was actually clicked, i.e. the site may have received the URL. */
  clicked: boolean;
  /** Wall time from launch start to close end, i.e. the browser time this run used. 0 when no browser started. */
  browserMs: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class RunError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const isNavigationRace = (e: unknown) =>
  /Execution context was destroyed|Cannot find context|Target closed|Session closed|Inspected target navigated/i.test(
    e instanceof Error ? e.message : String(e),
  );

async function findElement(page: PageLike, script: string): Promise<ElementLike | null> {
  let handle: HandleLike | undefined;
  try {
    handle = await page.evaluateHandle(script);
    const el = handle.asElement();
    if (!el) {
      await handle.dispose();
      return null;
    }
    return el as ElementLike;
  } catch (e) {
    await handle?.dispose().catch(() => undefined);
    if (isNavigationRace(e)) return null;
    throw e;
  }
}

async function waitForElement(
  page: PageLike,
  script: string,
  timeoutMs: number,
  pollMs: number,
  ready: (el: ElementLike) => Promise<boolean> = async () => true,
): Promise<ElementLike | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const el = await findElement(page, script);
    if (el) {
      let ok = false;
      try {
        ok = await ready(el);
      } catch (e) {
        if (!isNavigationRace(e)) throw e;
      }
      if (ok) return el;
      await el.dispose().catch(() => undefined);
    }
    if (Date.now() >= deadline) return null;
    await sleep(pollMs);
  }
}

async function readSnapshot(page: PageLike, script: string): Promise<Snapshot | null> {
  try {
    return (await page.evaluate(script)) as Snapshot;
  } catch (e) {
    if (isNavigationRace(e)) return null;
    throw e;
  }
}

function describe(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return sanitizeText(raw.split("\n")[0] ?? raw, 300);
}

export async function runBraveSubmission(targetUrl: string, options: CoreSubmitOptions): Promise<SubmitOutcome> {
  const meter: { start?: number; end?: number } = {};
  const outcome = await runFlow(targetUrl, options, meter);
  // Measured after close() returned, so it covers the whole session the platform bills for (launch to close).
  outcome.browserMs = meter.start === undefined ? 0 : Math.max(0, (meter.end ?? Date.now()) - meter.start);
  return outcome;
}

async function runFlow(targetUrl: string, options: CoreSubmitOptions, meter: { start?: number; end?: number }): Promise<SubmitOutcome> {
  const timings: Timings = { ...DEFAULT_TIMINGS, ...options.timings };
  const submitPageUrl = options.submitPageUrl ?? BRAVE_SUBMIT_URL;
  const allowedOrigin = new URL(submitPageUrl).origin;
  const startedAt = Date.now();
  const durationMs = () => Math.max(0, Date.now() - startedAt);
  const overBudget = () => durationMs() >= timings.totalBudgetMs;

  const label = options.site?.label ?? "Brave";
  const manualUrl = options.site?.manualUrl ?? BRAVE_SUBMIT_URL;
  const receivedNote =
    options.site?.receivedNote ??
    "Acceptance means the URL was received; it is not a guarantee that Brave will index it.";
  const classifyOptions = options.site?.classifyOptions ?? {};
  const snapshotScript = options.site?.snapshotScript ?? READ_SNAPSHOT;
  const redact = options.redact ?? [];
  const takeScreenshots = options.screenshots !== false;

  const observed: string[] = [];
  let lastSignature = "";
  let lastSnap: Snapshot | null = null;
  let browser: BrowserLike | undefined;
  let page: PageLike | undefined;
  let clicked = false;
  let offOriginUrl: string | null = null;

  const note = (snap: Snapshot, obs: Observation) => {
    const sig = signature(snap, obs);
    if (sig === lastSignature || observed.length >= 12) return;
    lastSignature = sig;
    observed.push(`+${((durationMs()) / 1000).toFixed(1)}s ${sig}`);
  };

  const diagnostics = async (): Promise<{ diag: Diagnostics; screenshot?: string }> => {
    let screenshot: string | undefined;
    if (takeScreenshots && page && !page.isClosed()) {
      try {
        const shot = await page.screenshot({ type: "jpeg", quality: 55, encoding: "base64" });
        if (typeof shot === "string") screenshot = shot;
      } catch {
        /* page may be mid-navigation or closed; diagnostics are best-effort */
      }
    }
    return {
      screenshot,
      diag: {
        finalUrl: page && !page.isClosed() ? stripUrl(page.url()) : undefined,
        observed,
        domExcerpt: lastSnap ? sanitizeText(lastSnap.bodyText, 1200, redact) : undefined,
        screenshotAttached: screenshot !== undefined,
      },
    };
  };

  const fail = async (status: SubmitResult["status"], message: string, errorCode?: ErrorCode): Promise<SubmitOutcome> => {
    const { diag, screenshot } = await diagnostics();
    return {
      result: { targetUrl, status, message, errorCode, durationMs: durationMs(), diagnostics: diag },
      screenshot,
      clicked,
      browserMs: 0,
    };
  };

  try {
    meter.start = Date.now();
    try {
      browser = await options.launch();
    } catch (e) {
      const hint = options.launchFailureHint?.(e) ?? "";
      return await fail("error", `Could not launch a browser: ${describe(e)}.${hint}`, "browser_launch_failed");
    }

    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    page.on("framenavigated", (frame) => {
      if (frame !== page!.mainFrame()) return;
      const url = frame.url();
      if (url && url !== "about:blank" && new URL(url).origin !== allowedOrigin) offOriginUrl = stripUrl(url);
    });

    // Navigation
    let status: number | undefined;
    try {
      const response = await page.goto(submitPageUrl, {
        waitUntil: "domcontentloaded",
        timeout: Math.min(timings.navigationMs, Math.max(1_000, timings.totalBudgetMs - durationMs())),
      });
      status = response?.status();
    } catch (e) {
      return await fail("error", `Could not load ${label}'s submit page: ${describe(e)}`, "navigation_failed");
    }
    if (status !== undefined && status >= 400) {
      const rate = status === 429 ? ` ${label} is rate-limiting this client; do not retry immediately."` : "";
      return await fail("error", `${label}'s submit page returned HTTP ${status}.${rate}`, "http_error");
    }

    // Inputs: the URL first, then any extra fields (Viesearch's contact email). Each typed value is
    // read back; a changed value aborts the run instead of submitting something else.
    const fields = [{ script: FIND_URL_INPUT, value: targetUrl, label: "URL" as string }].concat(
      (options.extraFields ?? []).map((f) => ({ script: f.script, value: f.value, label: f.label })),
    );
    for (const field of fields) {
      const input = await waitForElement(page, field.script, timings.uiReadyMs, timings.pollMs);
      if (!input) {
        return await fail(
          "error",
          `The ${field.label} input did not appear on ${label}'s submit page (page layout may have changed).`,
          "input_not_found",
        );
      }
      await input.focus();
      await input.type(field.value);
      const typed = (await input.evaluate((el) => el.value)) as string;
      await input.dispose().catch(() => undefined);
      if (typed !== field.value) {
        return await fail(
          "error",
          `The page changed the ${field.label} while it was being entered; refusing to submit a different value.`,
          "input_mismatch",
        );
      }
    }

    // Submit button: must be the exact "Submit" button and must be enabled.
    const isEnabled = (el: ElementLike) =>
      el.evaluate((b) => !b.disabled && b.getAttribute("aria-disabled") !== "true");
    const button = await waitForElement(page, FIND_SUBMIT_BUTTON, timings.uiReadyMs, timings.pollMs, isEnabled);
    if (!button) {
      const snap = await readSnapshot(page, snapshotScript);
      lastSnap = snap;
      const present = snap?.buttons.map((b) => `${b.text}${b.disabled ? " (disabled)" : ""}`).join(", ") || "none";
      const code: ErrorCode = snap?.buttons.some((b) => /^submit$/i.test(b.text)) ? "submit_button_disabled" : "submit_button_not_found";
      return await fail(
        "error",
        code === "submit_button_disabled"
          ? `The Submit button never became enabled after entering the URL (visible buttons: ${present}). ${label}'s page did not accept the value; no explicit rejection text was shown.`
          : `No enabled "Submit" button was found (visible buttons: ${present}).`,
        code,
      );
    }
    if (overBudget()) {
      await button.dispose().catch(() => undefined);
      return await fail("timeout", `Ran out of time budget before submitting; nothing was sent to ${label}.`);
    }

    await button.click();
    clicked = true;
    await button.dispose().catch(() => undefined);
    const clickedAt = Date.now();

    // Observe: SPA update or full navigation, no unconditional navigation wait.
    let challengeSince: number | null = null;
    let lastObs: Observation = { kind: "pending", note: "no snapshot yet" };
    for (;;) {
      if (offOriginUrl) {
        return await fail("error", `The page navigated away from ${label}'s submit page (to ${offOriginUrl}); aborting.`, "unexpected_navigation");
      }
      const elapsed = Date.now() - clickedAt;
      const snap = await readSnapshot(page, snapshotScript);
      if (snap) {
        lastSnap = snap;
        lastObs = classify(snap, classifyOptions);
        note(snap, lastObs);
        options.onSnapshot?.(snap, elapsed);

        if (elapsed >= timings.minSettleMs) {
          if (lastObs.kind === "accepted") {
            return {
              result: {
                targetUrl,
                status: "accepted",
                message: `${label}'s page showed an explicit success confirmation. ${receivedNote}`,
                confirmationText: sanitizeText(lastObs.confirmationText, 300, redact),
                durationMs: durationMs(),
              },
              clicked,
              browserMs: 0,
            };
          }
          if (lastObs.kind === "rejected") {
            const out = await fail("rejected", `${label}'s page showed an error after submission: "${sanitizeText(lastObs.text, 300, redact)}"`);
            return out;
          }
          if (lastObs.kind === "verification") {
            challengeSince ??= Date.now();
            if (Date.now() - challengeSince >= timings.challengePersistMs) {
              return await fail(
                "verification_required",
                `${label}'s page is asking for a human verification step that this server will not attempt to solve (${lastObs.evidence}). Complete the submission manually at ${manualUrl}.`,
              );
            }
          } else {
            challengeSince = null;
          }
        }
      }
      if (elapsed >= timings.observeMs || overBudget()) break;
      await sleep(timings.pollMs);
    }

    const ambiguous = lastObs.kind === "pending" ? ` Last state: ${lastObs.note}.` : "";
    return await fail(
      "timeout",
      `Clicked Submit but saw no definitive confirmation or rejection within ${Math.round((Date.now() - clickedAt) / 1000)}s.${ambiguous} The URL may or may not have been received by ${label}; check manually before retrying.`,
    );
  } catch (e) {
    return await fail("error", `Unexpected failure: ${describe(e)}`, "unexpected_error");
  } finally {
    if (browser) await options.close(browser);
    meter.end = Date.now();
  }
}
