// audit-site engine. Every value in the result is read from a response we actually received; nothing is estimated,
// defaulted or invented. All outbound requests go through safeFetch (SSRF guard).
import type { AuditResult } from "./contract.js";
import { urlProblem } from "./schema.js";
// "#safe-fetch" resolves to the Node guard (src/safe-fetch.ts) or, under the "workerd" condition, the Workers guard (package.json "imports").
import { safeFetch as realSafeFetch } from "#safe-fetch";
import type { SafeFetchOptions, SafeFetchResult } from "./safe-fetch-core.js";

/** UTF-8 byte length without node:buffer (runs on Node and Workers). */
const utf8Bytes = (s: string) => new TextEncoder().encode(s).byteLength;

type Rule = "allowed" | "blocked" | "unspecified";
type Finding = AuditResult["findings"][number];
type SuggestedFile = AuditResult["suggestedFiles"][number];
type PageSpeed = NonNullable<AuditResult["pageSpeed"]>;

export interface AuditDeps {
  safeFetch?: (url: string, opts?: SafeFetchOptions) => Promise<SafeFetchResult>;
  env?: Record<string, string | undefined>;
  now?: () => number;
}

// Brave documents no crawler token, so none is checked. Google-Extended is a robots.txt control token only (no UA string).
const ALL_BOTS = ["GPTBot", "OAI-SearchBot", "ClaudeBot", "PerplexityBot", "Google-Extended", "Googlebot", "Bingbot"] as const;
// Allow lines are only suggested for search/answer crawlers; allowing training crawlers (GPTBot, ClaudeBot, Google-Extended) is the site owner's policy call.
const SUGGEST_ALLOW = ["OAI-SearchBot", "PerplexityBot"] as const;
const AI_BOTS = ["GPTBot", "OAI-SearchBot", "ClaudeBot", "PerplexityBot", "Google-Extended"] as const;
// Caller-controlled text is bounded before any scan so a hostile page or robots.txt cannot cost more than linear time.
const MAX_HTML_CHARS = 256 * 1024;
const MAX_TAGS_PER_KIND = 2000;
const MAX_ATTR_CHARS = 4096;
const MAX_ROBOTS_CHARS = 512 * 1024;
const MAX_ROBOTS_LINES = 10_000;
const MAX_ROBOTS_LINE_CHARS = 1024;
const MAX_SITEMAP_LINES = 50;
const MAX_LLMS_LINKS = 10;
const PAGESPEED_TIMEOUT_MS = 25_000;
const PAGESPEED_MAX_BYTES = 12 * 1_048_576; // Lighthouse JSON includes a full-page screenshot and can be several MB

// ---- HTML ----------------------------------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0",
  mdash: "\u2014", ndash: "\u2013", hellip: "\u2026", rsquo: "\u2019", lsquo: "\u2018", rdquo: "\u201d", ldquo: "\u201c",
  copy: "\u00a9", reg: "\u00ae", trade: "\u2122", middot: "\u00b7", bull: "\u2022", laquo: "\u00ab", raquo: "\u00bb",
};
const MAX_ENTITY_CHARS = 10; // longest name or number body we look at; anything longer is left as written
const isDigit = (c: number) => c >= 48 && c <= 57;
const isHex = (c: number) => isDigit(c) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70);

/**
 * Decodes the named entities in ENTITIES plus decimal (&#8212;) and hex (&#x2014;) references, in one left-to-right pass.
 * At each '&' it looks at most MAX_ENTITY_CHARS + 1 characters ahead for ';', so the cost is bounded per '&' and the
 * whole call is linear in the input. Anything it does not recognise (unknown names, no ';', 0, above U+10FFFF,
 * surrogates) is left exactly as written. Decoded text is never decoded again (&amp;amp; becomes &amp;).
 */
export function decodeEntities(s: string): string {
  let amp = s.indexOf("&");
  if (amp === -1) return s;
  const parts: string[] = [];
  let last = 0;
  while (amp !== -1) {
    let semi = -1;
    const limit = Math.min(s.length, amp + MAX_ENTITY_CHARS + 2);
    for (let j = amp + 1; j < limit; j++) {
      if (s.charCodeAt(j) === 59) {
        semi = j;
        break;
      }
    }
    let replacement: string | undefined;
    if (semi > amp + 1) {
      const body = s.slice(amp + 1, semi);
      if (body.charCodeAt(0) === 35) {
        const hex = body.charCodeAt(1) === 120 || body.charCodeAt(1) === 88;
        const digits = body.slice(hex ? 2 : 1);
        let valid = digits.length > 0;
        for (let k = 0; valid && k < digits.length; k++) valid = hex ? isHex(digits.charCodeAt(k)) : isDigit(digits.charCodeAt(k));
        if (valid) {
          const cp = Number.parseInt(digits, hex ? 16 : 10);
          if (cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff)) replacement = String.fromCodePoint(cp);
        }
      } else {
        replacement = ENTITIES[body.toLowerCase()];
      }
    }
    if (replacement === undefined) {
      amp = s.indexOf("&", amp + 1);
      continue;
    }
    parts.push(s.slice(last, amp), replacement);
    last = semi + 1;
    amp = s.indexOf("&", last);
  }
  parts.push(s.slice(last));
  return parts.join("");
}
const decode = decodeEntities;
const clean = (s: string | undefined) => {
  const v = decode(s ?? "").replace(/\s+/g, " ").trim();
  return v || undefined;
};

function attrs(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of source.matchAll(/([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    const name = m[1]!.toLowerCase();
    if (!(name in out)) out[name] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return out;
}

function collectTypes(node: unknown, out: string[], depth = 0): void {
  if (depth > 5 || node === null || typeof node !== "object") return;
  if (Array.isArray(node)) return node.forEach((n) => collectTypes(n, out, depth + 1));
  const o = node as Record<string, unknown>;
  const t = o["@type"];
  for (const v of Array.isArray(t) ? t : [t]) if (typeof v === "string" && v && !out.includes(v)) out.push(v);
  if ("@graph" in o) collectTypes(o["@graph"], out, depth + 1);
}

export interface ParsedHtml {
  title: string | undefined;
  description: string | undefined;
  canonical: string | undefined;
  lang: string | undefined;
  jsonLdTypes: string[];
  hasOpenGraph: boolean;
  links: { url: string; text: string }[];
}

const isNameChar = (c: number) => (c >= 97 && c <= 122) || (c >= 48 && c <= 57); // a-z 0-9 on the lower-cased copy
const asciiLower = (s: string) => s.replace(/[A-Z]+/g, (m) => m.toLowerCase());

/**
 * Single left-to-right pass over at most MAX_HTML_CHARS. Every '<' is visited once and each tag is consumed up to
 * its '>', so no region is rescanned. Raw-text elements (script/style) are skipped with one indexOf for the closer;
 * an opener with no closer ends the scan. Anchors end at </a>, the next <a>, or the end of the text.
 */
export function parseHtml(source: string, pageUrl: string): ParsedHtml {
  const html = source.length > MAX_HTML_CHARS ? source.slice(0, MAX_HTML_CHARS) : source;
  const lower = asciiLower(html);
  const n = html.length;
  let origin = "";
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    // no links without a valid base
  }

  const types: string[] = [];
  const links: ParsedHtml["links"] = [];
  const seenLinks = new Set<string>();
  let title: string | undefined;
  let description: string | undefined;
  let canonical: string | undefined;
  let lang: string | undefined;
  let hasOpenGraph = false;
  let sawTitle = false;
  let sawHtml = false;
  let metas = 0;
  let linkTags = 0;
  let anchors = 0;
  let anchor: { href: string; text: string } | undefined;

  const closeAnchor = () => {
    if (!anchor) return;
    const { href, text } = anchor;
    anchor = undefined;
    try {
      const u = new URL(decode(href).trim(), pageUrl);
      u.hash = "";
      if ((u.protocol === "http:" || u.protocol === "https:") && u.origin === origin && !seenLinks.has(u.href)) {
        seenLinks.add(u.href);
        links.push({ url: u.href, text: clean(text) ?? "" });
      }
    } catch {
      // unparseable href
    }
  };

  let i = 0;
  let prev = 0; // end of the last consumed tag; text between prev and the next '<' belongs to any open anchor
  let gt = -1; // cached position of the next '>' at or after i
  while (i < n) {
    i = html.indexOf("<", i);
    if (i === -1) break;
    if (lower.startsWith("<!--", i)) {
      const end = lower.indexOf("-->", i + 4);
      if (end === -1) break;
      prev = i = end + 3;
      continue;
    }
    const closing = html.charCodeAt(i + 1) === 47;
    const nameStart = i + (closing ? 2 : 1);
    let nameEnd = nameStart;
    while (nameEnd < n && nameEnd - nameStart < 12 && isNameChar(lower.charCodeAt(nameEnd))) nameEnd++;
    const name = lower.slice(nameStart, nameEnd);
    if (!name) {
      i++;
      continue;
    }
    if (gt < i) {
      gt = html.indexOf(">", i);
      if (gt === -1) break;
    }
    if (anchor && anchor.text.length < 1000) anchor.text += ` ${html.slice(prev, Math.min(i, prev + 1000))}`;
    const attrSource = closing ? "" : html.slice(nameEnd, Math.min(gt, nameEnd + MAX_ATTR_CHARS));
    prev = i = gt + 1;
    if (closing) {
      if (name === "a") closeAnchor();
      continue;
    }

    if (name === "script" || name === "style") {
      const closer = lower.indexOf(`</${name}`, i);
      if (closer === -1) break;
      const closerEnd = html.indexOf(">", closer);
      if (closerEnd === -1) break;
      if (name === "script" && /ld\+json/i.test(attrs(attrSource).type ?? "")) {
        try {
          collectTypes(JSON.parse(html.slice(i, closer)), types);
        } catch {
          // malformed JSON-LD is ignored, not reported as a type
        }
      }
      prev = i = closerEnd + 1;
    } else if (name === "title") {
      if (!sawTitle) {
        sawTitle = true;
        const closer = lower.indexOf("</title", i);
        if (closer !== -1) {
          title = clean(html.slice(i, Math.min(closer, i + 2000)));
          prev = i = closer;
        }
      }
    } else if (name === "html") {
      if (!sawHtml) {
        sawHtml = true;
        lang = clean(attrs(attrSource).lang);
      }
    } else if (name === "meta") {
      if (++metas <= MAX_TAGS_PER_KIND) {
        const a = attrs(attrSource);
        const key = (a.name ?? a.property ?? "").toLowerCase();
        if ((a.property ?? "").toLowerCase().startsWith("og:") || (a.name ?? "").toLowerCase().startsWith("og:")) hasOpenGraph = true;
        if (description === undefined && key === "description") description = clean(a.content);
      }
    } else if (name === "link") {
      if (canonical === undefined && ++linkTags <= MAX_TAGS_PER_KIND) {
        const a = attrs(attrSource);
        if (a.href && (a.rel ?? "").toLowerCase().split(/\s+/).includes("canonical")) canonical = decode(a.href).trim();
      }
    } else if (name === "a") {
      closeAnchor();
      if (++anchors <= MAX_TAGS_PER_KIND) {
        const href = attrs(attrSource).href;
        if (href && origin) anchor = { href, text: "" };
      }
    }
  }
  if (anchor && anchor.text.length < 1000) anchor.text += ` ${html.slice(prev, prev + 1000)}`;
  closeAnchor();

  return { title, description, canonical, lang, jsonLdTypes: types, hasOpenGraph, links };
}

// ---- robots.txt ----------------------------------------------------------------------------------------------

interface Group {
  agents: string[];
  rules: { allow: boolean; pattern: string }[];
}

function robotsLines(text: string): [string, string][] {
  const out: [string, string][] = [];
  const lines = text.slice(0, MAX_ROBOTS_CHARS).split("\n", MAX_ROBOTS_LINES);
  for (const raw of lines) {
    let line = raw.length > MAX_ROBOTS_LINE_CHARS ? raw.slice(0, MAX_ROBOTS_LINE_CHARS) : raw;
    if (out.length === 0 && line.charCodeAt(0) === 0xfeff) line = line.slice(1);
    const hash = line.indexOf("#");
    if (hash !== -1) line = line.slice(0, hash);
    line = line.trim();
    const i = line.indexOf(":");
    if (i > 0) out.push([line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim()]);
  }
  return out;
}

function parseGroups(text: string): Group[] {
  const groups: Group[] = [];
  let current: Group | undefined;
  let lastWasAgent = false;
  for (const [field, value] of robotsLines(text)) {
    if (field === "user-agent") {
      if (current && lastWasAgent) current.agents.push(value.toLowerCase());
      else groups.push((current = { agents: [value.toLowerCase()], rules: [] }));
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if ((field === "allow" || field === "disallow") && current && value) current.rules.push({ allow: field === "allow", pattern: value });
  }
  return groups;
}

/** Whether a robots pattern (with * wildcards and a trailing $ anchor) matches the path "/". No regex: patterns are caller-controlled. */
function matchesRoot(pattern: string): boolean {
  const anchored = pattern.endsWith("$");
  const core = anchored ? pattern.slice(0, -1) : pattern;
  const literal = core.replaceAll("*", "");
  return anchored ? literal === "/" || (literal === "" && core.length > 0) : literal === "" || literal === "/";
}

/** Longest matching pattern for "/" wins; on a tie Allow wins. undefined = no rule matches. */
function evaluateRoot(groups: Group[]): Rule | undefined {
  let best: { len: number; allow: boolean } | undefined;
  for (const { rules } of groups) {
    for (const r of rules) {
      if (!matchesRoot(r.pattern)) continue;
      const len = r.pattern.length;
      if (!best || len > best.len || (len === best.len && r.allow && !best.allow)) best = { len, allow: r.allow };
    }
  }
  return best && (best.allow ? "allowed" : "blocked");
}

/**
 * Rule for "/" per bot. A group naming the bot decides (case-insensitive, groups for the same agent are merged;
 * no matching rule there means allowed). Otherwise the * group counts only when it blocks "/"; anything else is
 * "unspecified" because no rule names the bot. Only the root path is evaluated.
 */
export function aiBotRules(robotsText: string | undefined): Record<string, Rule> {
  const groups = robotsText === undefined ? [] : parseGroups(robotsText);
  const out: Record<string, Rule> = {};
  for (const bot of ALL_BOTS) {
    const specific = groups.filter((g) => g.agents.includes(bot.toLowerCase()));
    if (specific.length) out[bot] = evaluateRoot(specific) ?? "allowed";
    else out[bot] = evaluateRoot(groups.filter((g) => g.agents.includes("*"))) === "blocked" ? "blocked" : "unspecified";
  }
  return out;
}

export function robotsSitemaps(text: string): string[] {
  return robotsLines(text)
    .filter(([f, v]) => f === "sitemap" && v)
    .map(([, v]) => v)
    .slice(0, MAX_SITEMAP_LINES);
}

// ---- helpers -------------------------------------------------------------------------------------------------

type Availability = "present" | "missing" | "unchecked";

const looksLikeHtml = (r: SafeFetchResult) => /html/i.test(r.headers["content-type"] ?? "") || /^\s*<(!doctype html|html)/i.test(r.bodyText.slice(0, 2048));

function availability(r: SafeFetchResult, kind: "text" | "sitemap"): Availability {
  if (r.error || r.blockedReason || r.status === 0 || r.status >= 500) return "unchecked";
  if (!r.ok || looksLikeHtml(r)) return "missing";
  if (kind === "sitemap" && !/<(urlset|sitemapindex)\b/i.test(r.bodyText)) return "missing";
  return "present";
}

const redact = (s: string, secret: string) => (secret ? s.split(secret).join("[redacted]").split(encodeURIComponent(secret)).join("[redacted]") : s);

async function pageSpeed(pageUrl: string, strategy: "mobile" | "desktop", key: string, fetchFn: NonNullable<AuditDeps["safeFetch"]>): Promise<PageSpeed> {
  const err = (reason: string): PageSpeed => ({ status: "error", reason: redact(reason, key) });
  try {
    const q = new URLSearchParams({ url: pageUrl, strategy: strategy.toUpperCase() });
    q.append("category", "PERFORMANCE");
    q.append("category", "SEO");
    q.set("key", key);
    const r = await fetchFn(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${q}`, { timeoutMs: PAGESPEED_TIMEOUT_MS, maxBytes: PAGESPEED_MAX_BYTES });
    if (r.blockedReason) return err(`PageSpeed request blocked: ${r.blockedReason}`);
    if (r.error) return err(`PageSpeed request failed: ${r.error}`);
    if (r.truncated) return err("PageSpeed response too large to read");
    let json: any;
    try {
      json = JSON.parse(r.bodyText);
    } catch {
      return err(r.ok ? "PageSpeed response was not valid JSON" : `PageSpeed API returned HTTP ${r.status}`);
    }
    if (!r.ok) {
      const msg = typeof json?.error?.message === "string" ? `: ${json.error.message}` : "";
      return err(`PageSpeed API returned HTTP ${r.status}${msg}`);
    }
    const lh = json?.lighthouseResult;
    if (!lh || typeof lh !== "object") return err("PageSpeed response had no lighthouseResult");
    if (lh.runtimeError?.code) return err(`Lighthouse reported ${lh.runtimeError.code}${lh.runtimeError.message ? `: ${lh.runtimeError.message}` : ""}`);

    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    const score = (v: unknown) => (num(v) === undefined ? undefined : Math.round((v as number) * 100));
    const audit = (id: string) => num(lh.audits?.[id]?.numericValue);
    const ms = (id: string) => (audit(id) === undefined ? undefined : Math.round(audit(id)!));
    const metrics = {
      performanceScore: score(lh.categories?.performance?.score),
      seoScore: score(lh.categories?.seo?.score),
      lcpMs: ms("largest-contentful-paint"),
      cls: audit("cumulative-layout-shift"),
      tbtMs: ms("total-blocking-time"),
      ttfbMs: ms("server-response-time"),
    };
    const present = Object.fromEntries(Object.entries(metrics).filter(([, v]) => v !== undefined));
    if (Object.keys(present).length === 0) return err("PageSpeed response contained no scores or metrics");
    return { status: "ok", strategy, ...present };
  } catch (e) {
    return err(`PageSpeed request failed: ${e instanceof Error ? e.message : "unknown error"}`);
  }
}

function draftLlmsTxt(p: ParsedHtml, pageUrl: string): string {
  const u = new URL(pageUrl);
  const name = (s: string) => s.replace(/[[\]]/g, "");
  const lines = [`# ${p.title ?? u.hostname}`, ""];
  if (p.description) lines.push(`> ${p.description}`, "");
  lines.push("## Pages", "", `- [${name(p.title ?? pageUrl)}](${pageUrl})`);
  for (const l of p.links.filter((l) => l.url !== pageUrl).slice(0, MAX_LLMS_LINKS)) lines.push(`- [${name(l.text || new URL(l.url).pathname)}](${l.url})`);
  return `${lines.join("\n")}\n`;
}

// ---- main ----------------------------------------------------------------------------------------------------

export async function auditSite(input: { targetUrl: string; strategy?: "mobile" | "desktop" }, deps: AuditDeps = {}): Promise<AuditResult> {
  const now = deps.now ?? Date.now;
  const fetchFn = deps.safeFetch ?? ((url, opts) => realSafeFetch(url, opts));
  const env = deps.env ?? process.env;
  const started = now();
  const targetUrl = input.targetUrl.trim();
  const strategy = input.strategy ?? "mobile";
  const stop = (status: AuditResult["status"], message: string): AuditResult => ({ status, targetUrl, message, findings: [], suggestedFiles: [], durationMs: now() - started });

  const problem = urlProblem(targetUrl);
  if (problem) return stop(/publicly reachable/.test(problem) ? "blocked" : "error", `targetUrl ${problem}`);

  const page = await fetchFn(targetUrl);
  if (page.blockedReason) return { ...stop("blocked", `Refused to fetch ${targetUrl}: ${page.blockedReason}`), finalUrl: page.finalUrl };
  if (page.error || page.status === 0) return stop("unreachable", `Could not fetch ${targetUrl}: ${page.error ?? "no response"}`);

  const finalUrl = page.finalUrl;
  const origin = new URL(finalUrl).origin;
  const sameOrigin: SafeFetchOptions = { allowedOrigin: origin };
  const pageIs2xx = page.ok;
  const isHtml = looksLikeHtml(page) || !page.headers["content-type"];
  const parsed = parseHtml(isHtml ? page.bodyText : "", finalUrl);

  const [llms, robots] = await Promise.all([fetchFn(`${origin}/llms.txt`, sameOrigin), fetchFn(`${origin}/robots.txt`, sameOrigin)]);
  const llmsState = availability(llms, "text");
  const robotsState = availability(robots, "text");
  const robotsText = robotsState === "present" ? robots.bodyText : undefined;

  const candidates: string[] = [];
  for (const s of robotsText ? robotsSitemaps(robotsText) : []) {
    try {
      const u = new URL(s, origin);
      if (u.origin === origin) candidates.push(u.href);
    } catch {
      // ignore malformed Sitemap line
    }
  }
  if (!candidates.includes(`${origin}/sitemap.xml`)) candidates.push(`${origin}/sitemap.xml`);
  let sitemapUrl: string | undefined;
  let sitemapState: Availability = "missing";
  for (const c of candidates.slice(0, 2)) {
    const r = await fetchFn(c, sameOrigin);
    const state = availability(r, "sitemap");
    if (state === "present") {
      sitemapUrl = c;
      sitemapState = "present";
      break;
    }
    if (state === "unchecked") sitemapState = "unchecked";
  }

  const aiBots = aiBotRules(robotsText);
  const findings: Finding[] = [];
  const add = (id: string, severity: Finding["severity"], message: string) => findings.push({ id, severity, message });

  if (!pageIs2xx) add("non-200", "warn", `The page returned HTTP ${page.status}.`);
  if (isHtml && (page.truncated || page.bodyText.length > MAX_HTML_CHARS)) {
    add("page-truncated", "info", `Only the first ${MAX_HTML_CHARS / 1024} KB of the page were analysed; the page body read was ${utf8Bytes(page.bodyText)} bytes${page.truncated ? " (fetch cap reached)" : ""}.`);
  }
  if (!isHtml) add("not-html", "warn", `The page content type is ${page.headers["content-type"]}, not HTML; page checks were skipped.`);
  else {
    if (!parsed.title) add("no-title", "missing", "The page has no <title>.");
    if (!parsed.description) add("no-meta-description", "missing", 'The page has no <meta name="description">.');
    if (!parsed.canonical) add("no-canonical", "warn", 'The page has no <link rel="canonical">.');
    if (!parsed.lang) add("no-html-lang", "warn", "The <html> element has no lang attribute.");
    if (!parsed.hasOpenGraph) add("no-open-graph", "warn", "The page has no Open Graph (og:) meta tags.");
    if (parsed.jsonLdTypes.length === 0) add("no-json-ld", "missing", "The page has no parseable JSON-LD structured data.");
  }
  if (llmsState === "missing") add("llms-txt-missing", "missing", `${origin}/llms.txt is not served (HTTP ${llms.status}${looksLikeHtml(llms) && llms.ok ? ", returned HTML" : ""}).`);
  if (llmsState === "unchecked") add("llms-txt-unchecked", "info", `Could not check ${origin}/llms.txt (${llms.error ?? llms.blockedReason ?? `HTTP ${llms.status}`}).`);
  if (robotsState === "missing") add("robots-txt-missing", "missing", `${origin}/robots.txt is not served (HTTP ${robots.status}${looksLikeHtml(robots) && robots.ok ? ", returned HTML" : ""}).`);
  if (robotsState === "unchecked") add("robots-txt-unchecked", "info", `Could not check ${origin}/robots.txt (${robots.error ?? robots.blockedReason ?? `HTTP ${robots.status}`}).`);
  if (sitemapState === "missing") add("sitemap-missing", "missing", `No sitemap found at ${candidates.slice(0, 2).join(" or ")}.`);
  if (sitemapState === "unchecked") add("sitemap-unchecked", "info", "Could not check for a sitemap.");
  for (const bot of ALL_BOTS) if (aiBots[bot] === "blocked") add(`ai-bot-blocked:${bot}`, "warn", `robots.txt blocks ${bot} from "/".`);
  const unspecified = AI_BOTS.filter((b) => aiBots[b] === "unspecified");
  if (robotsState !== "unchecked" && unspecified.length) add("ai-bots-unspecified", "info", `No robots.txt rule names: ${unspecified.join(", ")} (default behaviour applies).`);

  const suggestedFiles: SuggestedFile[] = [];
  if (pageIs2xx && isHtml) {
    if (llmsState === "missing") suggestedFiles.push({ path: "/llms.txt", kind: "llms.txt", content: draftLlmsTxt(parsed, finalUrl.split("#")[0]!) });
    if (parsed.jsonLdTypes.length === 0) {
      const ld: Record<string, string> = { "@context": "https://schema.org", "@type": "WebSite" };
      if (parsed.title) ld.name = parsed.title;
      ld.url = origin;
      if (parsed.description) ld.description = parsed.description;
      suggestedFiles.push({ path: "head:ld+json", kind: "json-ld", content: JSON.stringify(ld, null, 2) });
    }
  }
  const needAllow = SUGGEST_ALLOW.filter((b) => aiBots[b] !== "allowed");
  if (robotsState !== "unchecked" && needAllow.length) {
    suggestedFiles.push({
      path: robotsState === "present" ? "/robots.txt (append)" : "/robots.txt",
      kind: "robots.txt",
      content: `${needAllow.map((b) => `User-agent: ${b}\nAllow: /`).join("\n\n")}\n`,
    });
  }

  const key = (env.PAGESPEED_API_KEY ?? "").trim();
  const speed: PageSpeed = !key
    ? { status: "skipped", reason: "PAGESPEED_API_KEY not set" }
    : !pageIs2xx
      ? { status: "skipped", reason: `page returned HTTP ${page.status}` }
      : await pageSpeed(finalUrl, strategy, key, fetchFn);

  return {
    status: "ok",
    targetUrl,
    finalUrl,
    httpStatus: page.status,
    message: `Audited ${finalUrl}: HTTP ${page.status}, ${findings.length} finding(s).`,
    page: { title: parsed.title, description: parsed.description, canonical: parsed.canonical, lang: parsed.lang, jsonLdTypes: parsed.jsonLdTypes, hasOpenGraph: parsed.hasOpenGraph, bytes: utf8Bytes(page.bodyText) },
    aiReadiness: {
      llmsTxt: { present: llmsState === "present", url: `${origin}/llms.txt`, ...(llmsState === "present" ? { bytes: utf8Bytes(llms.bodyText) } : {}) },
      robotsTxt: { present: robotsState === "present", url: `${origin}/robots.txt`, aiBots },
      sitemap: { present: sitemapState === "present", ...(sitemapUrl ? { url: sitemapUrl } : {}) },
    },
    pageSpeed: speed,
    findings,
    suggestedFiles,
    durationMs: now() - started,
  };
}
