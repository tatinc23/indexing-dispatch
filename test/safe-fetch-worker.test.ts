// Workers SSRF guard: DoH resolution, port policy, manual redirects re-validated per hop, body cap, timeout.
// Everything runs against an injected fetch; no network.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { USER_AGENT } from "../src/safe-fetch-core.js";
import { DOH_ENDPOINT, dohResolver, safeFetchWorker } from "../src/worker/safe-fetch-worker.js";

type Call = { url: string; init?: RequestInit };

/** Fake network: DoH answers from `dns`, pages from `pages`. Records every call. */
function fakeNet(dns: Record<string, { A?: string[]; AAAA?: string[]; status?: number }>, pages: Record<string, () => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    if (url.startsWith(DOH_ENDPOINT)) {
      const u = new URL(url);
      const rec = dns[u.searchParams.get("name") ?? ""];
      const type = u.searchParams.get("type") as "A" | "AAAA";
      if (!rec) return Response.json({ Status: 3, Answer: [] });
      const list = rec[type] ?? [];
      return Response.json({ Status: rec.status ?? 0, Answer: [{ type: 5, data: "cname.example." }, ...list.map((data) => ({ type: type === "A" ? 1 : 28, data }))] });
    }
    const page = pages[url];
    if (!page) throw new Error(`unexpected fetch ${url}`);
    return page();
  };
  return { fetch, calls, pageCalls: () => calls.filter((c) => !c.url.startsWith(DOH_ENDPOINT)) };
}

const PUBLIC = { A: ["93.184.216.34"], AAAA: ["2606:2800:220:1:248:1893:25c8:1946"] };

describe("dohResolver", () => {
  it("returns A and AAAA data and ignores CNAME rows", async () => {
    const net = fakeNet({ "example.com": PUBLIC }, {});
    const ips = await dohResolver(net.fetch)("example.com");
    assert.deepEqual(ips.sort(), [...PUBLIC.A, ...PUBLIC.AAAA].sort());
    assert.equal(net.calls[0]!.init?.headers && (net.calls[0]!.init.headers as Record<string, string>).accept, "application/dns-json");
  });
  it("throws on NXDOMAIN and on HTTP errors", async () => {
    const net = fakeNet({}, {});
    await assert.rejects(dohResolver(net.fetch)("nope.example"));
    await assert.rejects(dohResolver(async () => new Response("x", { status: 502 }))("example.com"));
  });
});

describe("safeFetchWorker refusals", () => {
  const refuses = async (url: string, dns: Parameters<typeof fakeNet>[0] = {}) => {
    const net = fakeNet(dns, {});
    const r = await safeFetchWorker(url, {}, { fetch: net.fetch });
    assert.equal(r.ok, false, url);
    assert.ok(r.blockedReason, `${url}: ${JSON.stringify(r)}`);
    assert.equal(net.pageCalls().length, 0, `${url} must not be fetched`);
    return r;
  };

  it("refuses metadata, loopback, private, CGNAT and IPv6 non-global literals without DNS", async () => {
    for (const u of [
      "http://169.254.169.254/latest/meta-data/", "http://127.0.0.1/", "http://10.0.0.1/", "http://100.64.0.1/", "http://192.168.1.1/",
      "http://[::1]/", "http://[fd00::1]/", "http://[fe80::1]/", "http://[::ffff:127.0.0.1]/", "http://2130706433/", "http://0x7f.1/", "http://localhost/",
    ]) await refuses(u);
  });
  it("refuses a hostname whose DoH answer contains any private address (A or AAAA)", async () => {
    await refuses("https://rebind.example/", { "rebind.example": { A: ["127.0.0.1"] } });
    await refuses("https://mixed.example/", { "mixed.example": { A: ["93.184.216.34", "10.0.0.9"] } });
    await refuses("https://v6.example/", { "v6.example": { A: ["93.184.216.34"], AAAA: ["fd00::5"] } });
    await refuses("https://meta.example/", { "meta.example": { A: ["169.254.169.254"] } });
  });
  it("refuses ports other than 80/443, credentials and other schemes", async () => {
    const r = await refuses("http://example.com:8080/", { "example.com": PUBLIC });
    assert.match(r.blockedReason!, /port 8080/);
    await refuses("https://example.com:22/", { "example.com": PUBLIC });
    await refuses("https://user:pw@example.com/", { "example.com": PUBLIC });
    await refuses("ftp://example.com/", { "example.com": PUBLIC });
  });
  it("reports DNS failure as an error, not a block", async () => {
    const net = fakeNet({}, {});
    const r = await safeFetchWorker("https://nope.example/", {}, { fetch: net.fetch });
    assert.equal(r.blockedReason, undefined);
    assert.match(r.error ?? "", /dns/i);
  });
});

describe("safeFetchWorker fetching", () => {
  it("fetches with the fixed User-Agent and redirect: manual", async () => {
    const net = fakeNet({ "example.com": PUBLIC }, { "https://example.com/": () => new Response("<h1>hi</h1>", { headers: { "content-type": "text/html", "set-cookie": "a=b" } }) });
    const r = await safeFetchWorker("https://example.com/", {}, { fetch: net.fetch });
    assert.equal(r.ok, true);
    assert.equal(r.bodyText, "<h1>hi</h1>");
    assert.equal(r.headers["content-type"], "text/html");
    assert.equal(r.headers["set-cookie"], undefined);
    const init = net.pageCalls()[0]!.init!;
    assert.equal(init.redirect, "manual");
    assert.equal((init.headers as Record<string, string>)["user-agent"], USER_AGENT);
  });

  it("re-validates every redirect hop and refuses one that points at a private address", async () => {
    const net = fakeNet(
      { "example.com": PUBLIC, "internal.example": { A: ["10.1.2.3"] } },
      { "https://example.com/": () => new Response(null, { status: 302, headers: { location: "https://internal.example/admin" } }) },
    );
    const r = await safeFetchWorker("https://example.com/", {}, { fetch: net.fetch });
    assert.match(r.blockedReason ?? "", /10\.1\.2\.3/);
    assert.equal(net.pageCalls().length, 1);
  });

  it("refuses a redirect to the metadata literal and stops after 3 redirects", async () => {
    const meta = fakeNet({ "example.com": PUBLIC }, { "https://example.com/": () => new Response(null, { status: 301, headers: { location: "http://169.254.169.254/" } }) });
    assert.ok((await safeFetchWorker("https://example.com/", {}, { fetch: meta.fetch })).blockedReason);
    const hop = (n: number) => () => new Response(null, { status: 302, headers: { location: `/r${n + 1}` } });
    const chain = fakeNet({ "example.com": PUBLIC }, { "https://example.com/r0": hop(0), "https://example.com/r1": hop(1), "https://example.com/r2": hop(2), "https://example.com/r3": hop(3) });
    const r = await safeFetchWorker("https://example.com/r0", {}, { fetch: chain.fetch });
    assert.match(r.blockedReason ?? "", /more than 3 redirects/);
    assert.equal(chain.pageCalls().length, 4);
  });

  it("caps the body while streaming and reports truncation", async () => {
    const big = "x".repeat(5000);
    const net = fakeNet({ "example.com": PUBLIC }, { "https://example.com/": () => new Response(big) });
    const r = await safeFetchWorker("https://example.com/", { maxBytes: 1000 }, { fetch: net.fetch });
    assert.equal(r.bodyText.length, 1000);
    assert.equal(r.truncated, true);
  });

  it("times out on a stalled body without throwing", async () => {
    const stalled = () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("partial")); } }));
    const net = fakeNet({ "example.com": PUBLIC }, { "https://example.com/": stalled });
    const r = await safeFetchWorker("https://example.com/", { timeoutMs: 200 }, { fetch: net.fetch });
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /timed out/);
  });

  it("allowedOrigin refuses a cross-origin redirect", async () => {
    const net = fakeNet({ "example.com": PUBLIC }, { "https://example.com/key.txt": () => new Response(null, { status: 302, headers: { location: "https://other.example/key.txt" } }) });
    const r = await safeFetchWorker("https://example.com/key.txt", { allowedOrigin: "https://example.com" }, { fetch: net.fetch });
    assert.match(r.blockedReason ?? "", /allowed origin/);
  });
});
