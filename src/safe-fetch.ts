// SSRF-guarded GET for caller-supplied URLs (Node runtime). Resolves DNS itself, refuses non-public addresses, and connects
// to the exact address it validated (so a second DNS answer cannot redirect the socket). Redirects are followed by hand and
// every hop is re-checked. Uses node:http/https only; no cookies, no connection reuse. The runtime-neutral checks and the
// redirect loop live in ./safe-fetch-core.ts (shared with the Cloudflare Workers adapter in ./worker/safe-fetch-worker.ts).
import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { ACCEPT_HEADER, KEPT_HEADERS, USER_AGENT, runSafeFetch, stripBrackets, type Hop, type SafeFetchDeps, type SafeFetchOptions, type SafeFetchResult, type ValidatedTarget } from "./safe-fetch-core.js";

export { USER_AGENT, blockedAddressReason } from "./safe-fetch-core.js";
export type { SafeFetchDeps, SafeFetchOptions, SafeFetchResult } from "./safe-fetch-core.js";

async function defaultResolve(host: string): Promise<string[]> {
  return (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address);
}

function requestOnce(url: URL, target: ValidatedTarget, maxBytes: number, signal: AbortSignal): Promise<Hop> {
  return new Promise<Hop>((resolve, reject) => {
    const host = stripBrackets(url.hostname);
    const secure = url.protocol === "https:";
    let settled = false;
    let res: http.IncomingMessage | undefined;
    let decoder: ReturnType<typeof createGunzip> | undefined;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      fn();
    };
    const teardown = () => {
      decoder?.destroy();
      res?.destroy();
      req.destroy();
    };
    const fail = (err: Error) => finish(() => (teardown(), reject(err)));
    const onAbort = () => fail(new Error("request timed out"));

    const req = (secure ? https : http).request(
      {
        protocol: url.protocol,
        hostname: host,
        port: url.port || (secure ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        agent: false,
        servername: isIP(host) ? undefined : host,
        headers: { "user-agent": USER_AGENT, accept: ACCEPT_HEADER, "accept-encoding": "gzip, deflate, br" },
        // Pin the socket to the address we already validated; Host header and TLS SNI still use the hostname.
        lookup: ((_h: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) => {
          if (opts?.all) cb(null, [{ address: target.address, family: target.family }]);
          else cb(null, target.address, target.family);
        }) as never,
      },
      (r) => {
        res = r;
        const status = r.statusCode ?? 0;
        const headers: Record<string, string> = {};
        for (const k of KEPT_HEADERS) {
          const v = r.headers[k];
          if (typeof v === "string") headers[k] = v;
        }
        const location = typeof r.headers.location === "string" ? r.headers.location : undefined;
        if ([301, 302, 303, 307, 308].includes(status) && location) {
          return finish(() => (teardown(), resolve({ status, headers, location, bodyText: "", truncated: false })));
        }

        const enc = String(r.headers["content-encoding"] ?? "").toLowerCase();
        let stream: NodeJS.ReadableStream = r;
        if (enc === "gzip" || enc === "x-gzip") decoder = createGunzip();
        else if (enc === "deflate") decoder = createInflate() as never;
        else if (enc === "br") decoder = createBrotliDecompress() as never;
        if (decoder) {
          r.pipe(decoder);
          stream = decoder;
          decoder.on("error", (e) => fail(new Error(`could not decode ${enc} body: ${e.message}`)));
        }
        const chunks: Buffer[] = [];
        let total = 0;
        const done = (truncated: boolean) => finish(() => (teardown(), resolve({ status, headers, bodyText: Buffer.concat(chunks).toString("utf8"), truncated })));
        stream.on("data", (chunk: Buffer) => {
          const room = maxBytes - total;
          if (chunk.length > room) {
            chunks.push(chunk.subarray(0, room));
            total = maxBytes;
            done(true);
          } else {
            chunks.push(chunk);
            total += chunk.length;
          }
        });
        stream.on("end", () => done(false));
        r.on("error", (e) => fail(e));
        r.on("close", () => !r.complete && fail(new Error("connection closed before the response finished")));
      },
    );
    req.on("error", (e) => fail(e));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) return onAbort();
    req.end();
  });
}

export function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}, deps: SafeFetchDeps = {}): Promise<SafeFetchResult> {
  return runSafeFetch(rawUrl, opts, deps, { resolve: defaultResolve, request: requestOnce });
}
