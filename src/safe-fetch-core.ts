// Runtime-neutral half of the SSRF guard: address classification, URL checks and the redirect loop.
// No node:* imports, so it runs on Node (src/safe-fetch.ts) and on Cloudflare Workers (src/worker/safe-fetch-worker.ts).
// Each runtime supplies a resolver (system DNS / DNS-over-HTTPS) and a one-hop request function.

export const USER_AGENT = "brave-submitter-audit/1.0 (+https://github.com/tatinc23/brave-submitter)";

export const DEFAULT_TIMEOUT_MS = 8_000;
export const MAX_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_BYTES = 1_048_576;
export const MAX_MAX_BYTES = 16 * 1_048_576;
export const MAX_REDIRECTS = 3;
export const KEPT_HEADERS = ["content-type", "content-length", "last-modified", "etag"];
export const ACCEPT_HEADER = "text/html,text/plain,application/xml,application/json;q=0.9,*/*;q=0.5";

export interface SafeFetchOptions {
  /** Total budget for DNS + all hops. Default 8000, clamped to 30000. */
  timeoutMs?: number;
  /** Decoded body cap. Default 1 MB, clamped to 16 MB. */
  maxBytes?: number;
  /** Can only lower the built-in limit of 3. */
  maxRedirects?: number;
  /** Refuse any hop (including redirects) whose origin differs, e.g. "https://example.com". */
  allowedOrigin?: string;
}

export interface SafeFetchDeps {
  /** Returns every address for a hostname. Defaults to the runtime's resolver. */
  resolve?: (hostname: string) => Promise<string[]>;
  /** TEST SEAM: permits 127.0.0.0/8 and ::1 only. Never wired to env or defaults. */
  allowLoopbackForTests?: boolean;
}

export interface SafeFetchResult {
  /** 2xx response received. */
  ok: boolean;
  /** 0 when no response was received. */
  status: number;
  finalUrl: string;
  headers: Record<string, string>;
  bodyText: string;
  truncated: boolean;
  /** Set when our guard refused the target (scheme, credentials, address, port, redirect policy). */
  blockedReason?: string;
  /** Set for network-level failures: DNS, connect, timeout. */
  error?: string;
}

export type ValidatedTarget = { address: string; family: 4 | 6 };

/** One HTTP exchange. A redirect returns `location` and an empty body; nothing is followed here. */
export interface Hop {
  status: number;
  headers: Record<string, string>;
  location?: string;
  bodyText: string;
  truncated: boolean;
}

export interface SafeFetchRuntime {
  resolve: (hostname: string) => Promise<string[]>;
  request: (url: URL, target: ValidatedTarget, maxBytes: number, signal: AbortSignal) => Promise<Hop>;
  /** When set, only these TCP ports are allowed (explicit or scheme default). Node leaves it unset. */
  allowedPorts?: readonly number[];
}

// ---- IP literals (no node:net) --------------------------------------------------------------------------------

const V4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const HEX_GROUP = /^[0-9a-fA-F]{1,4}$/;

export function isIPv4(s: string): boolean {
  return V4.test(s);
}

/** Parses an IPv6 literal (no brackets, no zone id) into 8 groups, or null. Accepts a trailing dotted IPv4. */
export function parseV6(ip: string): number[] | null {
  if (ip.length < 2 || ip.length > 45 || !/^[0-9a-fA-F:.]+$/.test(ip) || !ip.includes(":")) return null;
  let head = ip;
  let tail: number[] = [];
  const dotted = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(ip);
  if (dotted) {
    const m = V4.exec(dotted[1]!);
    if (!m) return null;
    const o = m.slice(1).map(Number);
    tail = [(o[0]! << 8) | o[1]!, (o[2]! << 8) | o[3]!];
    const before = ip.slice(0, dotted.index);
    if (!before.endsWith(":")) return null;
    head = before + "0:0";
  } else if (ip.includes(".")) return null;
  const halves = head.split("::");
  if (halves.length > 2) return null;
  const [left, right] = halves as [string, string | undefined];
  const l = left ? left.split(":") : [];
  const r = right ? right.split(":") : [];
  if (![...l, ...r].every((g) => HEX_GROUP.test(g))) return null;
  if (right === undefined ? l.length !== 8 : l.length + r.length > 7) return null;
  const groups = [...l, ...Array(right === undefined ? 0 : 8 - l.length - r.length).fill("0"), ...r].map((g) => Number.parseInt(g, 16));
  if (tail.length) groups.splice(6, 2, ...tail);
  return groups.length === 8 ? groups : null;
}

export function isIPv6(s: string): boolean {
  return parseV6(s) !== null;
}

/** 4, 6 or 0, like node:net isIP (zone ids are not accepted). */
export function ipVersion(s: string): 0 | 4 | 6 {
  return isIPv4(s) ? 4 : isIPv6(s) ? 6 : 0;
}

function v4Reason(a: number, b: number, c: number): string | null {
  if (a === 0) return "0.0.0.0/8";
  if (a === 10) return "private 10.0.0.0/8";
  if (a === 100 && b >= 64 && b <= 127) return "carrier-grade NAT 100.64.0.0/10";
  if (a === 127) return "loopback";
  if (a === 169 && b === 254) return "link-local / cloud metadata 169.254.0.0/16";
  if (a === 172 && b >= 16 && b <= 31) return "private 172.16.0.0/12";
  if (a === 192 && b === 168) return "private 192.168.0.0/16";
  if (a === 192 && b === 0 && c === 0) return "reserved 192.0.0.0/24";
  if (a === 192 && b === 0 && c === 2) return "documentation range";
  if (a === 198 && (b === 18 || b === 19)) return "benchmark range 198.18.0.0/15";
  if (a === 198 && b === 51 && c === 100) return "documentation range";
  if (a === 203 && b === 0 && c === 113) return "documentation range";
  if (a >= 224) return "multicast or reserved";
  return null;
}

/** Returns why an IP literal must not be fetched, or null when it is a public unicast address. */
export function blockedAddressReason(ip: string): string | null {
  const v4 = V4.exec(ip);
  if (v4) return v4Reason(Number(v4[1]), Number(v4[2]), Number(v4[3]));
  const g = parseV6(ip);
  if (!g) return "not a valid IP address";
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (zero(0, 5) && (g[5] === 0 || g[5] === 0xffff)) return "unspecified, loopback, IPv4-compatible or IPv4-mapped IPv6";
  if (g[0] === 0x64 && g[1] === 0xff9b) return "NAT64 prefix";
  if (g[0] === 0x2002) return v4Reason(g[1]! >> 8, g[1]! & 255, g[2]! >> 8) && "6to4 wrapping a non-public IPv4";
  if (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0xdb8)) return "Teredo or documentation range";
  // Only global unicast 2000::/3 is allowed; this also excludes ULA, link-local, site-local and multicast.
  if (g[0]! >> 13 !== 1) return "not global unicast IPv6 (loopback, ULA, link-local, multicast or reserved)";
  return null;
}

// ---- The guarded loop ------------------------------------------------------------------------------------------

export const blockedResult = (finalUrl: string, reason: string): SafeFetchResult => ({ ok: false, status: 0, finalUrl, headers: {}, bodyText: "", truncated: false, blockedReason: reason });
export const failedResult = (finalUrl: string, error: string): SafeFetchResult => ({ ok: false, status: 0, finalUrl, headers: {}, bodyText: "", truncated: false, error });

export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
export const stripBrackets = (h: string) => (h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h);

function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

type Target = ValidatedTarget | { blockedReason: string } | { error: string };

async function validateTarget(url: URL, resolve: SafeFetchRuntime["resolve"], deps: SafeFetchDeps, allowedPorts: readonly number[] | undefined, signal: AbortSignal): Promise<Target> {
  if (url.protocol !== "http:" && url.protocol !== "https:") return { blockedReason: "only http and https URLs are allowed" };
  if (url.username || url.password) return { blockedReason: "URLs with embedded username or password (credentials) are not allowed" };
  const host = stripBrackets(url.hostname).toLowerCase().replace(/\.$/, "");
  if (!host) return { blockedReason: "URL has no hostname" };
  if (host === "localhost" || host.endsWith(".localhost")) return { blockedReason: "localhost is not a public host" };
  if (allowedPorts) {
    const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    if (!allowedPorts.includes(port)) return { blockedReason: `port ${port} is not allowed (only ${allowedPorts.join(" and ")})` };
  }

  const loopbackOk = (ip: string) => deps.allowLoopbackForTests === true && (/^127\./.test(ip) || ip === "::1");
  const check = (ip: string) => (loopbackOk(ip) ? null : blockedAddressReason(ip));

  let addresses: string[];
  if (ipVersion(host)) addresses = [host];
  else {
    try {
      addresses = await abortable((deps.resolve ?? resolve)(host), signal);
    } catch {
      return { error: signal.aborted ? "request timed out" : `DNS lookup failed for ${host}` };
    }
    if (addresses.length === 0) return { error: `DNS lookup failed for ${host}: no addresses` };
  }
  for (const ip of addresses) {
    const why = check(ip);
    if (why) return { blockedReason: `${host} resolves to ${ip}, which is not a public address (${why})` };
  }
  return { address: addresses[0]!, family: ipVersion(addresses[0]!) === 6 ? 6 : 4 };
}

/** The shared guarded GET: validate every hop, follow at most 3 redirects by hand, one overall deadline. */
export async function runSafeFetch(rawUrl: string, opts: SafeFetchOptions, deps: SafeFetchDeps, runtime: SafeFetchRuntime): Promise<SafeFetchResult> {
  const timeoutMs = clamp(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1, MAX_TIMEOUT_MS);
  const maxBytes = clamp(opts.maxBytes ?? DEFAULT_MAX_BYTES, 1, MAX_MAX_BYTES);
  const maxRedirects = clamp(opts.maxRedirects ?? MAX_REDIRECTS, 0, MAX_REDIRECTS);
  let current: URL;
  try {
    current = new URL(rawUrl);
  } catch {
    return blockedResult(rawUrl, "not a valid absolute URL");
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const seen = new Set<string>();
    for (let followed = 0; ; followed++) {
      if (opts.allowedOrigin && current.origin !== opts.allowedOrigin) return blockedResult(current.href, `redirect leaves the allowed origin (${opts.allowedOrigin})`);
      seen.add(current.href);
      const target = await validateTarget(current, runtime.resolve, deps, runtime.allowedPorts, ac.signal);
      if ("blockedReason" in target) return blockedResult(current.href, target.blockedReason);
      if ("error" in target) return failedResult(current.href, ac.signal.aborted ? `request timed out after ${timeoutMs} ms` : target.error);

      const hop = await runtime.request(current, target, maxBytes, ac.signal);
      if (hop.location === undefined) {
        return { ok: hop.status >= 200 && hop.status < 300, status: hop.status, finalUrl: current.href, headers: hop.headers, bodyText: hop.bodyText, truncated: hop.truncated };
      }
      if (followed >= maxRedirects) return blockedResult(current.href, `more than ${maxRedirects} redirects`);
      let next: URL;
      try {
        next = new URL(hop.location, current);
      } catch {
        return blockedResult(current.href, "redirect to an invalid URL");
      }
      if (seen.has(next.href)) return blockedResult(current.href, "redirect loop");
      current = next;
    }
  } catch (err) {
    const message = ac.signal.aborted ? `request timed out after ${timeoutMs} ms` : err instanceof Error ? err.message : "request failed";
    return failedResult(current.href, message.replace(/^request timed out$/, `request timed out after ${timeoutMs} ms`));
  } finally {
    clearTimeout(timer);
  }
}
