export interface Snapshot {
  url: string;
  buttons: { text: string; disabled: boolean }[];
  headings: string[];
  alerts: { text: string; role: string; explicitError: boolean }[];
  inputInvalid: boolean;
  confirmation: { messageText: string; regionText: string; hasSuccessHeading: boolean } | null;
  challenge: { frames: string[]; text: string | null };
  bodyText: string;
}

export type Observation =
  | { kind: "accepted"; confirmationText: string }
  | { kind: "rejected"; text: string }
  | { kind: "verification"; evidence: string }
  | { kind: "pending"; note: string };

/** Brave shows this notice on every state of the page; it is never an error. */
const PRIVACY_NOTICE = /private usage metrics/i;
const ERROR_WORDS =
  /\b(error|invalid|failed|failure|unable|couldn['’]?t|could not|not allowed|not accepted|rejected|too many|rate.?limit|try again|blocked|forbidden|denied)\b/i;

/**
 * Pure classification of one page snapshot. Conservative by design: anything not
 * explicitly confirmed or rejected is "pending", and the caller decides what a
 * deadline means.
 */
export function classify(snap: Snapshot): Observation {
  const conf = snap.confirmation;
  const submittedButton = snap.buttons.some((b) => /^submitted$/i.test(b.text));

  // Exact message AND corroboration from its own region ("Success") or the "Submitted" button.
  if (conf && (conf.hasSuccessHeading || submittedButton)) {
    return { kind: "accepted", confirmationText: conf.regionText };
  }

  const alert = snap.alerts.find(
    (a) => !PRIVACY_NOTICE.test(a.text) && (ERROR_WORDS.test(a.text) || a.explicitError),
  );
  if (alert) return { kind: "rejected", text: alert.text };
  if (snap.inputInvalid) return { kind: "rejected", text: "Brave marked the URL input as invalid (aria-invalid)." };

  // Human-action challenges only. Passive wording ("Verifying...", "Checking...") never matches.
  if (snap.challenge.frames.length > 0) {
    return { kind: "verification", evidence: `visible challenge frame from ${snap.challenge.frames.join(", ")}` };
  }
  if (snap.challenge.text) {
    return { kind: "verification", evidence: `challenge text "${snap.challenge.text}"` };
  }

  if (conf) {
    return {
      kind: "pending",
      note: "confirmation message seen without a Success heading or a 'Submitted' button; treated as unconfirmed",
    };
  }
  return { kind: "pending", note: "no confirmation yet" };
}

/** One short line describing the page state; used to build a de-duplicated timeline. */
export function signature(snap: Snapshot, obs: Observation): string {
  const buttons = snap.buttons.map((b) => `${b.text}${b.disabled ? "(disabled)" : ""}`).join("|") || "none";
  const headings = snap.headings.join("|") || "none";
  return `buttons=[${buttons}] headings=[${headings}] -> ${obs.kind}${obs.kind === "pending" ? ` (${obs.note})` : ""}`;
}

/** Strips long token-like strings and collapses whitespace before text leaves the process. */
export function sanitizeText(text: string, max = 1200): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  const redacted = collapsed.replace(/[A-Za-z0-9_\-+/=]{32,}/g, "[redacted]");
  return redacted.length > max ? `${redacted.slice(0, max)}…` : redacted;
}

/** Page URL without query string or fragment (those can carry tokens). */
export function stripUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "";
  }
}
