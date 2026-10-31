// Pure helpers for the submission canvas. No React, no DOM, no network: everything here is unit-tested
// (test/canvas-lib.test.ts). Every string built here uses only values that were observed or typed by the user.
import type { AuditResult, CanvasProps, CloudflareBaseline, IndexNowResult } from "../../src/contract.js";
import type { SubmitResult } from "../../src/schema.js";

export type ToolId = "brave" | "indexnow" | "audit" | "cloudflare";
export type ToolPhase = "idle" | "running" | "ready" | "warning" | "error";

/** Brave and audit run one URL per call, sequentially. Beyond this many URLs a single click does not go. */
export const MAX_SEQUENTIAL_URLS = 10;
/** IndexNow protocol batch limit used by this server (see docs/specs/2026-10-27-discovery-suite.md). */
export const MAX_INDEXNOW_URLS = 100;
export const MAX_INPUT_URLS = 100;

// ---------- props ----------

/** The host hands the view whatever the tool returned. Anything missing becomes the conservative value. */
export function normalizeProps(raw: unknown): CanvasProps {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const et = (r.enabledTools && typeof r.enabledTools === "object" ? r.enabledTools : {}) as Record<string, unknown>;
  return {
    initialUrls: Array.isArray(r.initialUrls) ? r.initialUrls.filter((u): u is string => typeof u === "string") : [],
    ...(typeof r.domain === "string" && r.domain.trim() ? { domain: r.domain.trim() } : {}),
    mode: r.mode === "autonomous" ? "autonomous" : "interactive",
    enabledTools: { cloudflare: et.cloudflare === true, pageSpeed: et.pageSpeed === true },
  };
}

/** Initial textarea content: the URLs the agent passed, else https://<domain>/ when only a domain was given. */
export function initialUrlText(props: CanvasProps): string {
  if (props.initialUrls.length > 0) return props.initialUrls.join("\n");
  if (props.domain) {
    const d = props.domain.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
    return d ? `https://${d}/` : "";
  }
  return "";
}

// ---------- URL input ----------

export interface UrlProblem {
  line: number; // 1-based line in the textarea
  value: string;
  reason: string;
}
export interface ParsedUrls {
  urls: string[]; // valid, de-duplicated, in order
  problems: UrlProblem[];
  duplicates: number;
}

/** Light client-side check only; the server validates again and its answer is what gets shown after a run. */
export function urlProblem(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "not an absolute URL (start with https://)";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "must use http or https";
  if (url.username || url.password) return "must not contain a username or password";
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || !host.includes(".")) return "must be a public host name";
  return null;
}

export function parseUrlList(text: string): ParsedUrls {
  const urls: string[] = [];
  const problems: UrlProblem[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  text.split(/\r?\n/).forEach((raw, i) => {
    // allow commas and spaces between URLs on one line
    for (const part of raw.split(/[\s,]+/)) {
      const value = part.trim();
      if (!value) continue;
      const reason = urlProblem(value);
      if (reason) {
        problems.push({ line: i + 1, value, reason });
      } else if (seen.has(value)) {
        duplicates += 1;
      } else {
        seen.add(value);
        urls.push(value);
      }
    }
  });
  return { urls, problems, duplicates };
}

export function hostsOf(urls: string[]): string[] {
  return [...new Set(urls.map((u) => new URL(u).host.toLowerCase()))];
}

// ---------- IndexNow ----------

/** indexnow.org/documentation (checked 2026-10-27): 8 to 128 characters, a-z A-Z 0-9 and dashes. */
export function indexNowKeyProblem(key: string): string | null {
  if (!key) return "Enter your IndexNow key.";
  if (key.length < 8 || key.length > 128) return "A key is 8 to 128 characters.";
  if (!/^[A-Za-z0-9-]+$/.test(key)) return "A key uses letters, digits and dashes only.";
  return null;
}

export function defaultKeyLocation(host: string, key: string): string {
  return `https://${host}/${key}.txt`;
}

export interface IndexNowPlan {
  ok: boolean;
  problem?: string;
  host?: string;
  args?: { host: string; key: string; urls: string[]; keyLocation?: string };
}

export function planIndexNow(urls: string[], key: string, keyLocation: string): IndexNowPlan {
  if (urls.length === 0) return { ok: false, problem: "Add at least one URL." };
  const hosts = hostsOf(urls);
  if (hosts.length > 1) {
    return { ok: false, problem: `IndexNow needs every URL on one host. Found ${hosts.length}: ${hosts.join(", ")}.` };
  }
  if (urls.length > MAX_INDEXNOW_URLS) {
    return { ok: false, problem: `IndexNow takes up to ${MAX_INDEXNOW_URLS} URLs per request.` };
  }
  const keyIssue = indexNowKeyProblem(key);
  if (keyIssue) return { ok: false, problem: keyIssue };
  const loc = keyLocation.trim();
  if (loc) {
    try {
      const u = new URL(loc);
      if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("scheme");
      if (u.host.toLowerCase() !== hosts[0]) return { ok: false, problem: `The key file must be on ${hosts[0]}.` };
    } catch {
      return { ok: false, problem: "Key file location must be a full URL." };
    }
  }
  return {
    ok: true,
    host: hosts[0],
    args: { host: hosts[0], key, urls, ...(loc ? { keyLocation: loc } : {}) },
  };
}

// ---------- Cloudflare ----------

/** Light check only; the server validates the zone and its answer is what gets shown. */
export function zoneIdProblem(zoneId: string): string | null {
  if (!zoneId) return "Enter the Cloudflare zone ID.";
  if (/\s/.test(zoneId)) return "A zone ID has no spaces.";
  return null;
}

// ---------- per-tool state ----------

export function bravePhase(results: SubmitResult[]): ToolPhase {
  if (results.length === 0) return "idle";
  if (results.every((r) => r.status === "accepted")) return "ready";
  if (results.some((r) => r.status === "error")) return "error";
  return "warning";
}

export function braveSummary(results: SubmitResult[], total: number): string {
  const accepted = results.filter((r) => r.status === "accepted").length;
  const pending = total - results.length;
  const parts = [`${accepted} of ${total} accepted`];
  if (pending > 0) parts.push(`${pending} not run`);
  return parts.join(", ");
}

export function indexNowPhase(r: IndexNowResult): ToolPhase {
  if (r.status === "submitted") return r.engines.length > 0 && r.engines.every((e) => e.ok) ? "ready" : "warning";
  if (r.status === "key_not_verified") return "warning";
  return "error";
}

export function auditPhase(r: AuditResult): ToolPhase {
  if (r.status !== "ok") return "error";
  return r.findings.some((f) => f.severity === "warn" || f.severity === "missing") ? "warning" : "ready";
}

export function cloudflarePhase(r: CloudflareBaseline): ToolPhase {
  if (r.status === "ok") return "ready";
  if (r.status === "not_configured") return "warning";
  return "error";
}

/** Brave statuses in plain words. Only "accepted" reads as success. */
export const BRAVE_STATUS_LABEL: Record<SubmitResult["status"], string> = {
  accepted: "Accepted",
  rejected: "Rejected",
  verification_required: "Brave asked for a human check",
  timeout: "No answer before the time limit",
  error: "Could not complete",
};

// ---------- formatting ----------

export function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)} s` : `${Math.round(ms)} ms`;
}

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

export function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

// ---------- units (left rail) ----------

export interface UnitMeta {
  id: ToolId;
  num: string;
  title: string;
  blurb: string;
}

/** Card copy. Each sentence states only what the tool really does (see SKILL.md and docs/engines-2026-10-27.md). */
export const UNITS: UnitMeta[] = [
  { id: "brave", num: "01", title: "Brave Search Indexer", blurb: "Fills Brave's submit form in a real headless browser and reports what Brave showed." },
  { id: "indexnow", num: "02", title: "IndexNow", blurb: "One request, shared with participating engines. Needs your key file hosted on your site." },
  { id: "audit", num: "03", title: "Site Audit", blurb: "Title, robots.txt, llms.txt, sitemap, structured data." },
  { id: "cloudflare", num: "04", title: "Cloudflare Baseline", blurb: "Reads requests, bytes and AI bot requests for one zone. You keep the result to compare later." },
];

/** One line for the unit card. The receipt panel shows the full reason below. */
export const CLOUDFLARE_OFF_SHORT = "Not enabled on this server.";
export const CLOUDFLARE_OFF_REASON = "Not enabled on this server. It needs CF_ANALYTICS_API_TOKEN and CF_ZONE_IDS set by whoever runs the server.";

export type UnitTone = "ok" | "idle" | "off" | "run" | "warn" | "bad";

/** The status word on a unit card. "READY" means: included in the next run and nothing blocks it. */
export function unitStatus(a: { enabled: boolean; included: boolean; blocked: boolean; phase: ToolPhase; progress?: string }): { word: string; tone: UnitTone } {
  if (!a.enabled) return { word: "SELF-HOST ONLY", tone: "off" };
  switch (a.phase) {
    case "running":
      return { word: a.progress ? `RUNNING ${a.progress}` : "RUNNING", tone: "run" };
    case "ready":
      return { word: "DONE", tone: "ok" };
    case "warning":
      return { word: "ATTENTION", tone: "warn" };
    case "error":
      return { word: "FAILED", tone: "bad" };
    default:
      if (!a.included) return { word: "OFF", tone: "off" };
      return a.blocked ? { word: "NEEDS INPUT", tone: "warn" } : { word: "READY", tone: "ok" };
  }
}

/** "3 VALID URLS · example.com" label for the buffer header. */
export function domainLabel(hosts: string[]): string {
  if (hosts.length === 0) return "";
  if (hosts.length === 1) return hosts[0];
  return `${hosts.length} hosts`;
}

export function braveTotals(results: SubmitResult[]): { accepted: number; other: number; ms: number } {
  const accepted = results.filter((r) => r.status === "accepted").length;
  return { accepted, other: results.length - accepted, ms: results.reduce((n, r) => n + r.durationMs, 0) };
}

/** Findings that are gaps (anything other than an info note). */
export function gapCount(a: AuditResult): number {
  return a.findings.filter((f) => f.severity === "warn" || f.severity === "missing").length;
}

// ---------- drawer content (real data only) ----------

export interface Facts {
  brave: SubmitResult[];
  indexNow?: IndexNowResult;
  /** The URLs that were sent in that IndexNow request (the result only carries a count). */
  indexNowUrls?: string[];
  audits: AuditResult[];
}

export function hasAnyFacts(f: Facts): boolean {
  return f.brave.length > 0 || !!f.indexNow || f.audits.some((a) => a.status === "ok");
}

/** URLs that have at least one observed result, in first-seen order. */
export function urlsWithFacts(f: Facts): string[] {
  const out: string[] = [];
  const add = (u: string) => {
    if (!out.includes(u)) out.push(u);
  };
  f.brave.forEach((r) => add(r.targetUrl));
  (f.indexNowUrls ?? []).forEach((u) => f.indexNow && add(u));
  f.audits.filter((a) => a.status === "ok").forEach((a) => add(a.targetUrl));
  return out;
}

/** Brave outcome in words that never read as more than what Brave's form showed. */
export const BRAVE_POST_WORD: Record<SubmitResult["status"], string> = {
  accepted: "accepted",
  rejected: "rejected",
  verification_required: "asked for a human check",
  timeout: "gave no answer before the time limit",
  error: "could not be completed",
};

/**
 * Length of a post the way X counts it: every link counts as 23 characters whatever its length, and a character outside
 * basic Latin counts as 2 (rounded up from X's per-range weights, so the count is never low for text this module builds).
 * The 23-character rule comes from secondary sources (checked 2026-10-28), not an X help page.
 */
export function xWeightedLength(text: string): number {
  let n = 0;
  let rest = text;
  rest = rest.replace(/https?:\/\/\S+/g, (m) => {
    n += 23;
    return "";
  });
  for (const ch of rest) n += (ch.codePointAt(0) ?? 0) <= 0x10ff ? 1 : 2;
  return n;
}

export const X_LIMIT = 280;

export interface SocialDrafts {
  url: string;
  x: string;
  xCount: number;
  linkedin: string;
  linkedinCount: number;
}

interface UrlFacts {
  brave?: string;
  indexNow?: string;
  audit?: string;
  auditLong?: string[];
  title?: string;
}

function factsForUrl(f: Facts, url: string): UrlFacts {
  const out: UrlFacts = {};
  const b = f.brave.find((r) => r.targetUrl === url);
  if (b) out.brave = `Brave Search submit form: ${BRAVE_POST_WORD[b.status]}.`;
  if (f.indexNow && (f.indexNowUrls ?? []).includes(url)) {
    const r = f.indexNow;
    if (r.status === "submitted") {
      const ok = r.engines.filter((e) => e.ok).length;
      out.indexNow = `IndexNow: submitted (${ok} of ${r.engines.length} endpoint${r.engines.length === 1 ? "" : "s"} answered OK).`;
    } else if (r.status === "key_not_verified") out.indexNow = "IndexNow: not sent, the key file was not verified.";
    else if (r.status === "rejected") out.indexNow = "IndexNow: rejected.";
    else out.indexNow = "IndexNow: could not be completed.";
  }
  const a = f.audits.find((x) => x.targetUrl === url && x.status === "ok");
  if (a) {
    const gaps = gapCount(a);
    const bits: string[] = [];
    if (a.aiReadiness) bits.push(`llms.txt ${a.aiReadiness.llmsTxt.present ? "found" : "not found"}`);
    bits.push(gaps === 0 ? "no gaps flagged" : `${gaps} gap${gaps === 1 ? "" : "s"} flagged`);
    out.audit = `Audit: ${bits.join(", ")}.`;
    const long: string[] = [];
    if (a.httpStatus) long.push(`HTTP ${a.httpStatus}`);
    if (a.aiReadiness) {
      long.push(`llms.txt ${a.aiReadiness.llmsTxt.present ? "found" : "not found"}`);
      long.push(`sitemap ${a.aiReadiness.sitemap.present ? "found" : "not found"}`);
    }
    if (a.page) long.push(a.page.jsonLdTypes.length > 0 ? `JSON-LD: ${a.page.jsonLdTypes.join(", ")}` : "no JSON-LD found");
    const ps = a.pageSpeed;
    if (ps?.status === "ok" && ps.performanceScore !== undefined) long.push(`PageSpeed performance ${ps.performanceScore}${ps.strategy ? ` (${ps.strategy})` : ""}`);
    long.push(gaps === 0 ? "no gaps flagged" : `${gaps} gap${gaps === 1 ? "" : "s"} flagged`);
    out.auditLong = long;
    out.title = a.page?.title?.trim() || undefined;
  }
  return out;
}

/**
 * X (within 280) and LinkedIn drafts for ONE url, from results observed in this session only. No hype words, no
 * claim of indexing or ranking: a submission is reported with the status the tool returned. Null when nothing was observed.
 */
export function buildSocialDrafts(f: Facts, url: string): SocialDrafts | null {
  const u = factsForUrl(f, url);
  if (!u.brave && !u.indexNow && !u.audit) return null;

  const xLines = [url, u.brave, u.indexNow, u.audit].filter((l): l is string => !!l);
  const keep: string[] = [];
  for (const line of xLines) {
    const next = [...keep, line].join("\n");
    if (keep.length === 0 || xWeightedLength(next) <= X_LIMIT) keep.push(line);
  }
  const x = keep.join("\n");

  const host = new URL(url).host;
  const lines: string[] = [`Checked ${u.title ?? host} (${url}).`, "", "What the tools reported:"];
  if (u.brave) lines.push(`- ${u.brave}`);
  if (u.indexNow) lines.push(`- ${u.indexNow}`);
  if (u.auditLong) lines.push(`- Audit: ${u.auditLong.join("; ")}.`);
  const linkedin = lines.join("\n");

  return { url, x, xCount: xWeightedLength(x), linkedin, linkedinCount: [...linkedin].length };
}

// ---------- LLM patch tabs ----------

export type PatchKind = "llms.txt" | "json-ld" | "robots.txt";
export interface PatchFile {
  path: string;
  content: string;
  from: string;
}
export interface PatchTab {
  kind: PatchKind;
  label: string;
  files: PatchFile[];
  /** Why the tab is empty. Only set when files is empty. */
  reason?: string;
}

/** One tab per suggestedFile kind the audit can produce. Files repeated across pages (same path and content) appear once. */
export function buildPatchTabs(audits: AuditResult[]): PatchTab[] {
  const ok = audits.filter((a) => a.status === "ok");
  const seen = new Set<string>();
  const all: (PatchFile & { kind: PatchKind })[] = [];
  for (const a of ok) {
    for (const sf of a.suggestedFiles) {
      const k = `${sf.kind}\n${sf.path}\n${sf.content}`;
      if (seen.has(k)) continue;
      seen.add(k);
      all.push({ kind: sf.kind, path: sf.path, content: sf.content, from: a.targetUrl });
    }
  }
  const empty = (what: string, extra?: string) => (ok.length === 0 ? "Run the site audit first. The audit drafts these files." : (extra ?? `The audit did not suggest a ${what} for these pages.`));
  const llmsPresent = ok.length > 0 && ok.every((a) => a.aiReadiness?.llmsTxt.present === true);
  const defs: { kind: PatchKind; label: string; what: string; extra?: string }[] = [
    { kind: "llms.txt", label: "/llms.txt", what: "/llms.txt", extra: llmsPresent ? "The audit found /llms.txt already in place, so it suggested none." : undefined },
    { kind: "json-ld", label: "SCHEMA.ORG JSON-LD", what: "JSON-LD block" },
    { kind: "robots.txt", label: "/robots.txt", what: "robots.txt change" },
  ];
  return defs.map((d) => {
    const files = all.filter((x) => x.kind === d.kind).map(({ kind: _k, ...rest }) => rest);
    return { kind: d.kind, label: d.label, files, ...(files.length === 0 ? { reason: empty(d.what, d.extra) } : {}) };
  });
}

/** Stateless "re-check in 7 days": a prompt to paste into the agent later. Nothing is scheduled. */
export function buildRecheckPrompt(baseline: CloudflareBaseline | undefined): string | null {
  if (!baseline || baseline.status !== "ok" || !baseline.zoneId) return null;
  const when = baseline.windowEnd ? ` The baseline window ended ${baseline.windowEnd}; run this about 7 days after that.` : " Run this about 7 days after the baseline was taken.";
  return [
    `Call the snapshot-cloudflare-baseline tool with zoneId "${baseline.zoneId}" and pass the baseline below as \`previous\`.`,
    "Then report the change in total requests, bytes and AI bot requests, and list each AI bot's requests now against the baseline.",
    "Do not invent numbers: use only what the tool returns." + when,
    "",
    "Baseline:",
    "```json",
    JSON.stringify(baseline, null, 2),
    "```",
  ].join("\n");
}

export function suggestedFilesBundle(files: { path: string; content: string }[]): string {
  return files.map((f) => `# ${f.path}\n${f.content.trimEnd()}\n`).join("\n");
}
