import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { gzipSync } from "node:zlib";
import { USER_AGENT, blockedAddressReason, safeFetch } from "../src/safe-fetch.js";

describe("blockedAddressReason", () => {
  const blocked = [
    "0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "127.0.0.1", "127.9.9.9", "100.64.0.1", "100.127.255.255",
    "169.254.169.254", "169.254.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "192.0.0.1", "198.18.0.1",
    "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255",
    "::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "febf::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:8.8.8.8",
    "::ffff:7f00:1", "64:ff9b::808:808", "2002:7f00:1::1", "2001:db8::1", "::127.0.0.1",
  ];
  const allowed = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "100.63.255.255", "100.128.0.1", "172.15.0.1", "172.32.0.1", "169.253.0.1", "2606:4700:4700::1111", "2001:4860:4860::8888"];

  for (const ip of blocked) it(`blocks ${ip}`, () => assert.ok(blockedAddressReason(ip), ip));
  for (const ip of allowed) it(`allows ${ip}`, () => assert.equal(blockedAddressReason(ip), null, ip));
  it("blocks strings that are not IP addresses", () => assert.ok(blockedAddressReason("not-an-ip")));
});

const publicResolver = (ips: string[]) => async () => ips;

describe("safeFetch refusals (no sockets needed)", () => {
  it("refuses non-http schemes", async () => {
    for (const u of ["ftp://example.com/", "file:///etc/passwd", "javascript:alert(1)", "data:text/plain,hi", "gopher://example.com/"]) {
      const r = await safeFetch(u, {}, { resolve: publicResolver(["93.184.216.34"]) });
      assert.equal(r.ok, false, u);
      assert.match(r.blockedReason ?? "", /http/i, u);
    }
  });

  it("refuses malformed URLs without throwing", async () => {
    const r = await safeFetch("not a url");
    assert.equal(r.ok, false);
    assert.ok(r.blockedReason);
  });

  it("refuses credentials in the URL", async () => {
    for (const u of ["https://user:pw@example.com/", "https://user@example.com/", "http://:pw@example.com/"]) {
      const r = await safeFetch(u, {}, { resolve: publicResolver(["93.184.216.34"]) });
      assert.match(r.blockedReason ?? "", /username|password|credential/i, u);
    }
  });

  it("refuses literal private/loopback/metadata IPs, including odd spellings", async () => {
    for (const u of [
      "http://127.0.0.1/", "http://10.0.0.1/", "http://192.168.0.1/", "http://172.16.0.1/", "http://169.254.169.254/latest/meta-data/",
      "http://100.64.0.1/", "http://0.0.0.0/", "http://[::1]/", "http://[fd00::1]/", "http://[fe80::1]/", "http://[::ffff:127.0.0.1]/",
      "http://2130706433/", "http://0x7f.1/", "http://127.1/", "http://localhost/", "http://foo.localhost/",
    ]) {
      const r = await safeFetch(u, {}, { resolve: async () => assert.fail(`resolver must not be used for ${u}`) });
      assert.equal(r.ok, false, u);
      assert.ok(r.blockedReason, u);
    }
  });

  it("refuses a public-looking host whose DNS answer is private", async () => {
    for (const ip of ["10.1.2.3", "127.0.0.1", "169.254.169.254", "::1", "::ffff:10.0.0.1", "fd00::5"]) {
      const r = await safeFetch("https://looks-public.example/", {}, { resolve: publicResolver([ip]) });
      assert.ok(r.blockedReason, ip);
    }
  });

  it("refuses when ANY returned address is non-public", async () => {
    const r = await safeFetch("https://mixed.example/", {}, { resolve: publicResolver(["93.184.216.34", "10.0.0.9"]) });
    assert.ok(r.blockedReason);
  });

  it("reports DNS failure as an error, not a block and not a throw", async () => {
    const r = await safeFetch("https://nope.example/", {}, { resolve: async () => { throw new Error("ENOTFOUND") } });
    assert.equal(r.ok, false);
    assert.equal(r.blockedReason, undefined);
    assert.match(r.error ?? "", /dns/i);
    const empty = await safeFetch("https://nope.example/", {}, { resolve: async () => [] });
    assert.match(empty.error ?? "", /dns/i);
  });

  it("does not allow loopback by default, even for a real local server", async () => {
    const srv = createServer((_q, s) => s.end("hi"));
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    try {
      const port = (srv.address() as AddressInfo).port;
      const r = await safeFetch(`http://127.0.0.1:${port}/`);
      assert.ok(r.blockedReason);
      const viaDns = await safeFetch(`http://local.example:${port}/`, {}, { resolve: publicResolver(["127.0.0.1"]) });
      assert.ok(viaDns.blockedReason);
    } finally {
      srv.close();
    }
  });

  it("allowLoopbackForTests only relaxes loopback, never other private ranges", async () => {
    const r = await safeFetch("http://x.example/", {}, { resolve: publicResolver(["10.0.0.1"]), allowLoopbackForTests: true });
    assert.ok(r.blockedReason);
    const meta = await safeFetch("http://x.example/", {}, { resolve: publicResolver(["169.254.169.254"]), allowLoopbackForTests: true });
    assert.ok(meta.blockedReason);
  });
});

describe("safeFetch against a local fixture server", () => {
  let server: Server;
  let port = 0;
  let requests: { url: string; headers: IncomingMessage["headers"] }[] = [];
  let handler: (req: IncomingMessage, res: ServerResponse) => void = (_q, s) => s.end("ok");
  const local = { resolve: publicResolver(["127.0.0.1"]), allowLoopbackForTests: true };
  const base = (host = "fixture.example") => `http://${host}:${port}`;

  before(async () => {
    server = createServer((req, res) => {
      requests.push({ url: req.url ?? "", headers: req.headers });
      handler(req, res);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  after(() => {
    server.closeAllConnections();
    server.close();
  });
  const reset = (h: typeof handler) => {
    requests = [];
    handler = h;
  };

  it("fetches a page, preserving the Host header and sending the fixed User-Agent", async () => {
    reset((req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(`host=${req.headers.host};ua=${req.headers["user-agent"]};cookie=${req.headers.cookie ?? "none"}`);
    });
    const r = await safeFetch(`${base()}/page?q=1`, {}, local);
    assert.equal(r.ok, true);
    assert.equal(r.status, 200);
    assert.equal(r.truncated, false);
    assert.equal(r.finalUrl, `${base()}/page?q=1`);
    assert.equal(r.headers["content-type"], "text/html; charset=utf-8");
    assert.equal(r.bodyText, `host=fixture.example:${port};ua=${USER_AGENT};cookie=none`);
    assert.equal(USER_AGENT, "brave-submitter-audit/1.0 (+https://github.com/tatinc23/brave-submitter)");
  });

  it("connects to the address it validated and resolves each hop once", async () => {
    reset((_q, res) => res.end("pinned"));
    let calls = 0;
    const resolve = async () => {
      calls++;
      return calls === 1 ? ["127.0.0.1"] : ["10.0.0.1"]; // a rebinding resolver: only the first answer may ever be used
    };
    const r = await safeFetch(`${base()}/`, {}, { resolve, allowLoopbackForTests: true });
    assert.equal(r.bodyText, "pinned");
    assert.equal(calls, 1);
  });

  it("follows redirects (relative and absolute) and reports the final URL; no cookies are replayed", async () => {
    reset((req, res) => {
      if (req.url === "/a") {
        res.writeHead(302, { location: "/b", "set-cookie": "sid=1" });
        return res.end();
      }
      if (req.url === "/b") {
        res.writeHead(301, { location: `${base()}/c` });
        return res.end();
      }
      res.end("done");
    });
    const r = await safeFetch(`${base()}/a`, {}, local);
    assert.equal(r.ok, true);
    assert.equal(r.finalUrl, `${base()}/c`);
    assert.equal(r.bodyText, "done");
    assert.ok(requests.every((q) => q.headers.cookie === undefined));
  });

  it("stops at 3 redirects", async () => {
    reset((req, res) => {
      const n = Number(req.url!.slice(1)) || 0;
      res.writeHead(302, { location: `/${n + 1}` });
      res.end();
    });
    const r = await safeFetch(`${base()}/0`, {}, local);
    assert.equal(r.ok, false);
    assert.match(r.blockedReason ?? "", /redirect/i);
    assert.equal(requests.length, 4); // original + 3 followed
    reset((req, res) => {
      if (req.url === "/0" || req.url === "/1" || req.url === "/2") {
        res.writeHead(302, { location: `/${Number(req.url!.slice(1)) + 1}` });
        return res.end();
      }
      res.end("three hops is fine");
    });
    assert.equal((await safeFetch(`${base()}/0`, {}, local)).bodyText, "three hops is fine");
  });

  it("detects a redirect loop", async () => {
    reset((req, res) => {
      res.writeHead(302, { location: req.url === "/a" ? "/b" : "/a" });
      res.end();
    });
    const r = await safeFetch(`${base()}/a`, {}, local);
    assert.equal(r.ok, false);
    assert.match(r.blockedReason ?? "", /redirect/i);
    assert.ok(requests.length <= 4);
  });

  it("re-validates every hop: redirect to private, metadata, userinfo, other scheme, or a host that resolves privately", async () => {
    const targets = [
      "http://10.0.0.1/", "http://169.254.169.254/latest/meta-data/", "http://[fd00::1]/", "http://user:pw@fixture.example/",
      "ftp://fixture.example/", "file:///etc/passwd", "http://internal.example/",
    ];
    const resolve = async (h: string) => (h === "internal.example" ? ["10.9.9.9"] : ["127.0.0.1"]);
    for (const t of targets) {
      reset((_q, res) => {
        res.writeHead(302, { location: t });
        res.end();
      });
      const r = await safeFetch(`${base()}/`, {}, { resolve, allowLoopbackForTests: true });
      assert.equal(r.ok, false, t);
      assert.ok(r.blockedReason, t);
      assert.equal(requests.length, 1, `${t} must not be requested`);
    }
  });

  it("allowedOrigin refuses a redirect that leaves the origin", async () => {
    reset((req, res) => {
      if (req.url === "/same") {
        res.writeHead(302, { location: "/ok" });
        return res.end();
      }
      if (req.url === "/ok") return res.end("fine");
      res.writeHead(302, { location: `http://elsewhere.example:${port}/ok` });
      res.end();
    });
    const origin = new URL(base()).origin;
    assert.equal((await safeFetch(`${base()}/same`, { allowedOrigin: origin }, local)).bodyText, "fine");
    const r = await safeFetch(`${base()}/out`, { allowedOrigin: origin }, local);
    assert.match(r.blockedReason ?? "", /origin/i);
  });

  it("caps the body at 1 MB by default and reports truncation", async () => {
    reset((_q, res) => {
      res.setHeader("content-type", "text/plain");
      res.write("a".repeat(900_000));
      res.write("b".repeat(900_000));
      res.end("c".repeat(900_000));
    });
    const r = await safeFetch(`${base()}/`, {}, local);
    assert.equal(r.ok, true);
    assert.equal(r.truncated, true);
    assert.equal(r.bodyText.length, 1_048_576);
    const small = await safeFetch(`${base()}/`, { maxBytes: 1000 }, local);
    assert.equal(small.bodyText.length, 1000);
    assert.equal(small.truncated, true);
  });

  it("does not mark a body that exactly fits as truncated", async () => {
    reset((_q, res) => res.end("x".repeat(500)));
    const r = await safeFetch(`${base()}/`, { maxBytes: 500 }, local);
    assert.equal(r.truncated, false);
    assert.equal(r.bodyText.length, 500);
  });

  it("decodes gzip, and the cap applies to decompressed bytes", async () => {
    reset((_q, res) => {
      res.setHeader("content-encoding", "gzip");
      res.end(gzipSync("hello gzip"));
    });
    assert.equal((await safeFetch(`${base()}/`, {}, local)).bodyText, "hello gzip");
    reset((_q, res) => {
      res.setHeader("content-encoding", "gzip");
      res.end(gzipSync("z".repeat(5_000_000))); // small on the wire, large decompressed
    });
    const r = await safeFetch(`${base()}/`, {}, local);
    assert.equal(r.truncated, true);
    assert.equal(r.bodyText.length, 1_048_576);
  });

  it("times out when the server never answers, without throwing", async () => {
    reset(() => {});
    const t0 = Date.now();
    const r = await safeFetch(`${base()}/`, { timeoutMs: 250 }, local);
    assert.equal(r.ok, false);
    assert.equal(r.blockedReason, undefined);
    assert.match(r.error ?? "", /timed out/i);
    assert.ok(Date.now() - t0 < 3000);
  });

  it("times out on a body that stalls part-way", async () => {
    reset((_q, res) => {
      res.write("start");
    });
    const r = await safeFetch(`${base()}/`, { timeoutMs: 250 }, local);
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /timed out/i);
  });

  it("reports non-2xx as ok:false with the status and body", async () => {
    reset((_q, res) => {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("nope");
    });
    const r = await safeFetch(`${base()}/missing`, {}, local);
    assert.equal(r.ok, false);
    assert.equal(r.status, 404);
    assert.equal(r.bodyText, "nope");
    assert.equal(r.blockedReason, undefined);
    assert.equal(r.error, undefined);
  });

  it("reports connection failure as an error", async () => {
    const dead = createServer();
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
    const p = (dead.address() as AddressInfo).port;
    dead.close();
    const r = await safeFetch(`http://fixture.example:${p}/`, {}, local);
    assert.equal(r.ok, false);
    assert.ok(r.error);
  });

  it("ignores caller-supplied limits that would loosen the guard", async () => {
    reset((req, res) => {
      const n = Number(req.url!.slice(1)) || 0;
      res.writeHead(302, { location: `/${n + 1}` });
      res.end();
    });
    const r = await safeFetch(`${base()}/0`, { maxRedirects: 50 }, local);
    assert.ok(r.blockedReason);
    assert.equal(requests.length, 4);
  });
});
