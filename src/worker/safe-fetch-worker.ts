// SSRF-guarded GET for Cloudflare Workers. node:http and DNS pinning do not exist there, so this adapter:
//  - resolves the hostname with DNS-over-HTTPS (Cloudflare's JSON API, A + AAAA) and refuses the URL if ANY answer is
//    private, loopback, link-local, CGNAT, metadata, reserved or non-global IPv6 (same rules as Node, src/safe-fetch-core.ts);
//  - allows only ports 80 and 443 (Workers' outbound fetch does not reach arbitrary ports anyway; measured 2026-10-29);
//  - fetches with redirect: "manual" (each hop is re-validated by the shared loop), a fixed User-Agent, an AbortController
//    deadline, and a streaming read that stops at the byte cap.
// Residual risk (documented in docs/cloudflare-port-plan.md): Workers' fetch resolves the hostname again itself, so a
// DNS-rebinding host could answer differently between our DoH check and the connection. Cloudflare's network refuses
// connections to private/loopback/metadata addresses from Workers (error 1003 for literals, 1016/530 for a hostname that
// resolves to 127.0.0.1, both measured 2026-10-29), which closes most of that window but is a platform property, not ours.
import { ACCEPT_HEADER, KEPT_HEADERS, USER_AGENT, runSafeFetch, type Hop, type SafeFetchDeps, type SafeFetchOptions, type SafeFetchResult } from "../safe-fetch-core.js";

export const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";
export const WORKER_ALLOWED_PORTS = [80, 443] as const;
const DOH_TYPES = { A: 1, AAAA: 28 } as const;

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

interface DohAnswer {
  type?: number;
  data?: string;
}

/** Resolves A and AAAA through DNS-over-HTTPS. Throws on lookup failure (NXDOMAIN, SERVFAIL, HTTP error). */
export function dohResolver(fetchFn: FetchFn = (u, i) => fetch(u, i), timeoutMs = 4_000) {
  return async (hostname: string): Promise<string[]> => {
    const query = async (type: keyof typeof DOH_TYPES) => {
      const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(hostname)}&type=${type}`;
      const res = await fetchFn(url, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`DoH HTTP ${res.status}`);
      const body = (await res.json()) as { Status?: number; Answer?: DohAnswer[] };
      // Status 0 = NOERROR. NOERROR with no records of this type is a normal empty answer (e.g. no AAAA).
      if (body.Status !== 0) throw new Error(`DoH status ${body.Status}`);
      return (body.Answer ?? []).filter((a) => a.type === DOH_TYPES[type] && typeof a.data === "string").map((a) => a.data as string);
    };
    const [a, aaaa] = await Promise.all([query("A"), query("AAAA")]);
    return [...a, ...aaaa];
  };
}

async function readCapped(res: Response, maxBytes: number, signal: AbortSignal): Promise<{ bodyText: string; truncated: boolean }> {
  if (!res.body) return { bodyText: "", truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  // A stalled body must not outlive the deadline, whatever the runtime does with the fetch signal.
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      reject(new Error("request timed out"));
      reader.cancel().catch(() => undefined);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  aborted.catch(() => undefined);
  try {
    return await readLoop();
  } finally {
    signal.removeEventListener("abort", onAbort);
  }

  async function readLoop(): Promise<{ bodyText: string; truncated: boolean }> {
  for (;;) {
    const { done, value } = await Promise.race([reader.read(), aborted]);
    if (signal.aborted) throw new Error("request timed out");
    if (done) break;
    const room = maxBytes - total;
    if (value.byteLength > room) {
      chunks.push(value.subarray(0, room));
      total = maxBytes;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return { bodyText: new TextDecoder().decode(all), truncated };
  }
}

/** One hop via the runtime's fetch. Workers decompress gzip/br transparently, so the cap applies to decoded bytes. */
export function workerRequest(fetchFn: FetchFn = (u, i) => fetch(u, i)) {
  return async (url: URL, _target: unknown, maxBytes: number, signal: AbortSignal): Promise<Hop> => {
    const res = await fetchFn(url.href, {
      method: "GET",
      redirect: "manual",
      headers: { "user-agent": USER_AGENT, accept: ACCEPT_HEADER },
      signal,
    });
    const headers: Record<string, string> = {};
    for (const k of KEPT_HEADERS) {
      const v = res.headers.get(k);
      if (v !== null) headers[k] = v;
    }
    const location = res.headers.get("location") ?? undefined;
    if ([301, 302, 303, 307, 308].includes(res.status) && location) {
      await res.body?.cancel().catch(() => undefined);
      return { status: res.status, headers, location, bodyText: "", truncated: false };
    }
    return { status: res.status, headers, ...(await readCapped(res, maxBytes, signal)) };
  };
}

export interface WorkerSafeFetchDeps extends SafeFetchDeps {
  /** Test seam: replaces the runtime fetch for both DoH and the page request. */
  fetch?: FetchFn;
}

export function safeFetchWorker(rawUrl: string, opts: SafeFetchOptions = {}, deps: WorkerSafeFetchDeps = {}): Promise<SafeFetchResult> {
  return runSafeFetch(rawUrl, opts, deps, {
    resolve: dohResolver(deps.fetch),
    request: workerRequest(deps.fetch),
    allowedPorts: WORKER_ALLOWED_PORTS,
  });
}
