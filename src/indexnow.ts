// submit-indexnow engine. Pings ONE IndexNow endpoint (the protocol shares a submission with every participating
// engine; see docs/engines-2026-10-27.md section 1). Before pinging it proves the key file is live on the host, using
// the SSRF-guarded fetch. Single attempt, never retries. Nothing here invents a result: the status is what the endpoint said.
import { ipVersion } from "./safe-fetch-core.js";
import type { IndexNowResult } from "./contract.js";
import { MAX_URL_LENGTH } from "./schema.js";
// "#safe-fetch" resolves to the Node guard (src/safe-fetch.ts) or, under the "workerd" condition, the Workers guard (package.json "imports").
import { safeFetch as realSafeFetch } from "#safe-fetch";
import type { SafeFetchOptions, SafeFetchResult } from "./safe-fetch-core.js";

export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
export const INDEXNOW_ENGINE = "api.indexnow.org";
/** Our own cap. The protocol allows 10,000 per POST; we stay far below it. */
export const MAX_INDEXNOW_URLS = 100;
const KEY_PATTERN = /^[A-Za-z0-9-]{8,128}$/;
const HOST_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const POST_TIMEOUT_MS = 10_000;

export interface IndexNowInput {
  host: string;
  key: string;
  urls: string[];
  keyLocation?: string;
}

export interface IndexNowDeps {
  safeFetch?: (url: string, opts?: SafeFetchOptions) => Promise<SafeFetchResult>;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
}

export async function submitIndexNow(input: IndexNowInput, deps: IndexNowDeps = {}): Promise<IndexNowResult> {
  const now = deps.now ?? Date.now;
  const fetchKey = deps.safeFetch ?? ((url, opts) => realSafeFetch(url, opts));
  const post = deps.fetch ?? ((url, init) => fetch(url, init));
  const started = now();

  const host = (input.host ?? "").trim().toLowerCase();
  const key = input.key ?? "";
  let keyLocation = input.keyLocation?.trim() || `https://${host}/${key}.txt`;

  const result = (status: IndexNowResult["status"], message: string, extra: Partial<IndexNowResult> = {}): IndexNowResult => ({
    status,
    host,
    urlCount: 0,
    keyLocation,
    keyVerified: false,
    engines: [],
    message,
    durationMs: now() - started,
    ...extra,
  });
  const invalid = (message: string) => result("error", message);

  if (!HOST_PATTERN.test(host) || ipVersion(host)) return invalid("host must be a bare public hostname such as www.example.com (no scheme, path, port or IP address).");
  if (!KEY_PATTERN.test(key)) return invalid("key must be 8 to 128 characters: letters, digits and hyphens only (the IndexNow key rules).");

  let keyUrl: URL;
  try {
    keyUrl = new URL(keyLocation);
  } catch {
    return invalid("keyLocation must be an absolute http(s) URL.");
  }
  if (!/^https?:$/.test(keyUrl.protocol) || keyUrl.username || keyUrl.password || keyUrl.hostname !== host) {
    return invalid(`keyLocation must be an http(s) URL on ${host} without credentials.`);
  }
  keyLocation = keyUrl.href;
  const keyFolder = keyUrl.pathname.slice(0, keyUrl.pathname.lastIndexOf("/") + 1);

  const given = Array.isArray(input.urls) ? input.urls : [];
  if (given.length === 0) return invalid("urls must contain at least one URL.");
  if (given.length > MAX_INDEXNOW_URLS) return invalid(`urls has ${given.length} entries; this server accepts at most ${MAX_INDEXNOW_URLS} per call.`);

  const urls: string[] = [];
  for (const raw of given) {
    if (typeof raw !== "string" || raw.length > MAX_URL_LENGTH || /\s/.test(raw)) return invalid(`Not an acceptable URL (whitespace, too long or not text): ${String(raw).slice(0, 80)}`);
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return invalid(`Not an absolute URL: ${raw.slice(0, 80)}`);
    }
    if (!/^https?:$/.test(u.protocol)) return invalid(`URL must use http or https: ${raw.slice(0, 80)}`);
    if (u.username || u.password) return invalid(`URL must not contain credentials: ${raw.slice(0, 80)}`);
    if (u.hostname !== host) return invalid(`URL is not on host ${host} (exact host match required, subdomains are separate hosts): ${raw.slice(0, 80)}`);
    if (!u.pathname.startsWith(keyFolder)) return invalid(`URL is outside the key file's folder ${keyFolder}: ${raw.slice(0, 80)}. A key file only covers URLs under its own path.`);
    if (!urls.includes(u.href)) urls.push(u.href);
  }

  // Prove the key file is live and exact before asking any engine to do work.
  const keyFile = await fetchKey(keyLocation, { allowedOrigin: keyUrl.origin });
  if (keyFile.blockedReason) return result("blocked", `Refused to fetch the key file ${keyLocation}: ${keyFile.blockedReason}`, { urlCount: urls.length });
  if (keyFile.error || keyFile.status === 0) return result("key_not_verified", `Could not fetch the key file ${keyLocation}: ${keyFile.error ?? "no response"}. Nothing was sent to IndexNow.`, { urlCount: urls.length });
  if (!keyFile.ok) return result("key_not_verified", `The key file ${keyLocation} answered HTTP ${keyFile.status}. Host it as plain text containing only the key. Nothing was sent to IndexNow.`, { urlCount: urls.length });
  if (keyFile.truncated || keyFile.bodyText.trim() !== key) {
    return result("key_not_verified", `The key file ${keyLocation} does not contain exactly the key (it must hold only the key, as plain text). Nothing was sent to IndexNow.`, { urlCount: urls.length });
  }

  const base = { urlCount: urls.length, keyVerified: true };
  const engine = (ok: boolean, message: string, httpStatus?: number) => [{ engine: INDEXNOW_ENGINE, endpoint: INDEXNOW_ENDPOINT, ok, message, ...(httpStatus === undefined ? {} : { httpStatus }) }];

  let res: Response;
  try {
    res = await post(INDEXNOW_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ host, key, keyLocation, urlList: urls }),
      redirect: "manual",
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
  } catch (e) {
    const why = (e instanceof Error ? e.message : String(e)).slice(0, 200);
    return result("error", `The request to IndexNow failed (${why}). It was attempted once and not retried; whether IndexNow received it is unknown.`, { ...base, engines: engine(false, why) });
  }

  const s = res.status;
  const note = "A submission is a request to crawl, not a promise that the pages will be indexed.";
  if (s === 200 || s === 202) {
    const m = s === 202 ? "IndexNow accepted the request (HTTP 202: received, key validation pending)." : "IndexNow accepted the request (HTTP 200: URLs received).";
    return result("submitted", `${m} One ping is shared with every participating engine. ${note}`, { ...base, engines: engine(true, m, s) });
  }
  if (s === 429) {
    const ra = res.headers.get("retry-after")?.trim();
    const retry = ra && /^[0-9A-Za-z ,:+-]{1,40}$/.test(ra) ? ` Retry-After: ${ra}.` : "";
    const m = `HTTP 429: too many requests (potential spam).${retry} Wait 10 minutes before resubmitting the same URLs.`;
    return result("rejected", m, { ...base, engines: engine(false, m, s) });
  }
  const rejected: Record<number, string> = {
    400: "HTTP 400: bad request, invalid format.",
    403: "HTTP 403: the key is not valid for this host (key file not found, or the file does not contain the key).",
    422: "HTTP 422: a URL does not belong to the host, the key does not match the protocol schema, or the same URL set is being resubmitted without changes.",
  };
  if (rejected[s] || (s >= 400 && s < 500)) {
    const m = rejected[s] ?? `HTTP ${s}: the request was refused.`;
    return result("rejected", m, { ...base, engines: engine(false, m, s) });
  }
  const m = `Unexpected response HTTP ${s}. Not retried; whether the URLs were received is unknown.`;
  return result("error", m, { ...base, engines: engine(false, m, s) });
}
