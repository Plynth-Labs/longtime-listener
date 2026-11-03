import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGateway } from "./public-gateway.mjs";

async function fixture(t, options = {}) {
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    if (req.url.includes("empty=1")) { res.writeHead(204); return res.end(); }
    if (req.url.includes("/audio/")) {
      res.writeHead(206, { "content-type": "audio/mpeg", "content-range": "bytes 0-2/6", "accept-ranges": "bytes" });
      return res.end(Buffer.from([0, 128, 255]));
    }
    res.writeHead(200, { "content-type": "application/json", "set-cookie": "upstream=private" });
    res.end('{"ok":true}');
  }).listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const gateway = createGateway({ upstream: `http://127.0.0.1:${upstream.address().port}/newscast/api/`, ...options }).listen(0, "127.0.0.1");
  await once(gateway, "listening");
  t.after(() => {
    gateway.closeAllConnections(); gateway.close();
    upstream.closeAllConnections(); upstream.close();
  });
  return { base: `http://127.0.0.1:${gateway.address().port}`, seen };
}
const origin = "https://drop.jonomatus.ky";

test("the page origin's preflight is allowed; other origins and private routes never reach upstream", async (t) => {
  const { base, seen } = await fixture(t);
  const preflight = await fetch(base + "/api/show/describe", { method: "OPTIONS", headers: { origin } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
  assert.match(preflight.headers.get("access-control-allow-headers"), /x-listener-id/);
  assert.equal((await fetch(base + "/api/status", { headers: { origin: "https://other.example" } })).status, 403);
  for (const route of ["/newscast/", "/data/profiles/listener.json", "/api/%2F%2Fevil.example", "/api/../private", "/api//evil.example"]) {
    const response = await fetch(base + route);
    assert.ok(response.status >= 400, route);
  }
  assert.equal(seen.length, 0);
});

test("binary voice upload and listener identity survive; credentials and cookies do not", async (t) => {
  const { base, seen } = await fixture(t);
  const bytes = Buffer.from([0, 255, 128, 1, 9]);
  const response = await fetch(base + "/api/show/describe", {
    method: "POST", body: bytes,
    headers: { origin, "content-type": "audio/webm", "x-listener-id": "l_test", cookie: "private=1", authorization: "Bearer test-only" },
  });
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(seen[0].body, bytes);
  assert.equal(seen[0].url, "/newscast/api/show/describe");
  assert.equal(seen[0].headers["x-listener-id"], "l_test");
  assert.equal(seen[0].headers.cookie, undefined);
  assert.equal(seen[0].headers.authorization, undefined);
});

test("audio ranges stream intact with the query listener and CORS", async (t) => {
  const { base, seen } = await fixture(t);
  const response = await fetch(base + "/api/audio/seg_1/0?listener=l_test", { headers: { origin, range: "bytes=0-2" } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 0-2/6");
  assert.equal(response.headers.get("access-control-allow-origin"), origin);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from([0, 128, 255]));
  assert.equal(seen[0].url, "/newscast/api/audio/seg_1/0?listener=l_test");
  assert.equal(seen[0].headers.range, "bytes=0-2");
});

test("work budget is finite, resets hourly, and leaves progress available", async (t) => {
  let now = 0;
  const { base } = await fixture(t, { maxWorkPerHour: 2, now: () => now });
  for (let i = 0; i < 2; i++) assert.equal((await fetch(base + "/api/next")).status, 200);
  assert.equal((await fetch(base + "/api/next")).status, 429);
  assert.equal((await fetch(base + "/api/progress", { method: "POST", headers: { origin }, body: "{}" })).status, 200);
  now = 3600000;
  assert.equal((await fetch(base + "/api/next")).status, 200);
});

test("saved playback remains available after generation budget is exhausted", async (t) => {
  const { base } = await fixture(t, { maxWorkPerHour: 1 });
  assert.equal((await fetch(base + "/api/next")).status, 200);
  assert.equal((await fetch(base + "/api/next")).status, 429);
  for (const route of ["episodes/ep_fixture/open", "episodes/ep_fixture/share"]) {
    assert.equal((await fetch(base + "/api/" + route, { method: "POST", headers: { origin } })).status, 200);
  }
  for (let index = 0; index < 5; index++) {
    assert.equal((await fetch(base + "/api/replay/next")).status, 200);
  }
  assert.equal((await fetch(base + "/api/call/submit", { method: "POST", headers: { origin } })).status, 429);
  assert.equal((await fetch(base + "/api/shared/share_fixture/open", { method: "POST", headers: { origin } })).status, 429);
});

test("oversized recordings are rejected before reaching the private app", async (t) => {
  const { base, seen } = await fixture(t, { maxBody: 8 });
  const response = await fetch(base + "/api/call/submit", { method: "POST", headers: { origin }, body: Buffer.alloc(9) });
  assert.equal(response.status, 413);
  assert.equal(seen.length, 0);
});


test("empty long polls do not drain the work budget", async (t) => {
  const { base } = await fixture(t, { maxWorkPerHour: 1 });
  for (let i = 0; i < 8; i++) assert.equal((await fetch(base + "/api/next?empty=1")).status, 204);
  assert.equal((await fetch(base + "/api/show/describe", { method: "POST", headers: { origin }, body: "{}" })).status, 200);
});

test("all routes have a bounded request budget, including progress and media", async (t) => {
  const { base } = await fixture(t, { maxClientRequestsPerMinute: 2 });
  assert.equal((await fetch(base + "/api/status")).status, 200);
  assert.equal((await fetch(base + "/api/progress", { method: "POST", headers: { origin }, body: "{}" })).status, 200);
  assert.equal((await fetch(base + "/api/audio/seg_1/0")).status, 429);
});

test("idle long polls do not occupy the generation slot", async (t) => {
  let release;
  const stalled = new Promise(resolve => { release = resolve; });
  const { base } = await fixture(t, { maxConcurrent: 1, fetcher: async (url) => {
    if (url.pathname.endsWith("/next")) { await stalled; return new Response(null, { status: 204 }); }
    return new Response("{}");
  } });
  const pending = fetch(base + "/api/next");
  await new Promise(resolve => setTimeout(resolve, 50));
  try { assert.equal((await fetch(base + "/api/show/describe", { method: "POST", headers: { origin }, body: "{}" })).status, 200); }
  finally { release(); await pending; }
});

test("upstream server errors never expose provider details", async (t) => {
  const { base } = await fixture(t, { fetcher: async () => new Response("provider internals", { status: 500 }) });
  const response = await fetch(base + "/api/status");
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /provider internals/);
});


test("a stalled upload is disconnected and releases its generation slot", async (t) => {
  const { base } = await fixture(t, { maxConcurrent: 1, timeoutMs: 60 });
  await new Promise((resolve, reject) => {
    const request = http.request(base + "/api/show/describe", { method: "POST", headers: { origin, "content-length": "8" } });
    request.on("error", resolve);
    request.on("response", reject);
    request.write("x");
  });
  assert.equal((await fetch(base + "/api/show/describe", { method: "POST", headers: { origin }, body: "{}" })).status, 200);
});

test("the hourly ceiling survives a restart, so idling does not refill it", async (t) => {
  const budgetFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "gateway-budget-")), "budget.json");
  const first = await fixture(t, { budgetFile, maxWorkPerHour: 2 });
  for (let i = 0; i < 2; i += 1) {
    assert.equal((await fetch(first.base + "/api/show/describe", { method: "POST", headers: { origin }, body: "{}" })).status, 200);
  }
  assert.equal((await fetch(first.base + "/api/show/describe", { method: "POST", headers: { origin }, body: "{}" })).status, 429);

  // A new process on the same volume is what an idle machine restart looks like.
  const restarted = await fixture(t, { budgetFile, maxWorkPerHour: 2 });
  assert.equal((await fetch(restarted.base + "/api/show/describe", { method: "POST", headers: { origin }, body: "{}" })).status, 429);

  // The hour turning over is the only thing that refills it.
  await fs.writeFile(budgetFile, JSON.stringify({ windowStart: Date.now() - 3600001, workCount: 2 }));
  const nextHour = await fixture(t, { budgetFile, maxWorkPerHour: 2 });
  assert.equal((await fetch(nextHour.base + "/api/show/describe", { method: "POST", headers: { origin }, body: "{}" })).status, 200);
});

test("a corrupt or over-generous budget file never grants more than a fresh hour", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-budget-"));
  const budgetFile = path.join(dir, "budget.json");
  await fs.writeFile(budgetFile, "{ not json");
  const corrupt = await fixture(t, { budgetFile, maxWorkPerHour: 1 });
  assert.equal((await fetch(corrupt.base + "/api/show/describe", { method: "POST", headers: { origin }, body: "{}" })).status, 200);
  assert.equal((await fetch(corrupt.base + "/api/show/describe", { method: "POST", headers: { origin }, body: "{}" })).status, 429);

  // A negative count would otherwise hand the caller extra budget.
  const generous = path.join(dir, "generous.json");
  await fs.writeFile(generous, JSON.stringify({ windowStart: Date.now(), workCount: -1000 }));
  const clamped = await fixture(t, { budgetFile: generous, maxWorkPerHour: 1 });
  assert.equal((await fetch(clamped.base + "/api/show/describe", { method: "POST", headers: { origin }, body: "{}" })).status, 200);
  assert.equal((await fetch(clamped.base + "/api/show/describe", { method: "POST", headers: { origin }, body: "{}" })).status, 429);
});

test("readiness reflects the app behind the gateway, not just the gateway", async (t) => {
  const healthy = await fixture(t);
  const up = await fetch(healthy.base + "/ready");
  assert.equal(up.status, 200);
  assert.deepEqual(await up.json(), { ok: true });

  // /health only ever proved this process was alive; that stays true.
  assert.equal((await fetch(healthy.base + "/health")).status, 200);

  const unreachable = await fixture(t, { fetcher: async () => { throw new Error("connection refused"); } });
  const down = await fetch(unreachable.base + "/ready");
  assert.equal(down.status, 503);
  assert.deepEqual(await down.json(), { ok: false });

  const broken = await fixture(t, { fetcher: async () => new Response("boom", { status: 500 }) });
  assert.equal((await fetch(broken.base + "/ready")).status, 503);
});

test("readiness and health never spend admission budget", async (t) => {
  const { base } = await fixture(t, { maxWorkPerHour: 1 });
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await fetch(base + "/ready")).status, 200);
    assert.equal((await fetch(base + "/health")).status, 200);
  }
  assert.equal((await fetch(base + "/api/show/describe", { method: "POST", headers: { origin }, body: "{}" })).status, 200);
});

const describe = (base, headers = {}) =>
  fetch(base + "/api/show/describe", { method: "POST", headers: { origin, ...headers }, body: "{}" }).then((r) => r.status);

test("a forged X-Forwarded-For never buys a fresh client budget", async (t) => {
  for (const clientIpHeader of [null, "fly-client-ip"]) {
    const { base } = await fixture(t, { clientIpHeader, maxClientWorkPerHour: 1 });
    const edge = clientIpHeader ? { "fly-client-ip": "203.0.113.7" } : {};
    assert.equal(await describe(base, { ...edge, "x-forwarded-for": "198.51.100.1" }), 200);
    for (let i = 2; i < 6; i += 1) {
      assert.equal(await describe(base, { ...edge, "x-forwarded-for": `198.51.100.${i}` }), 429, String(clientIpHeader));
    }
  }
});

test("each address the edge reports gets its own client budget", async (t) => {
  const { base } = await fixture(t, { clientIpHeader: "fly-client-ip", maxClientWorkPerHour: 1 });
  assert.equal(await describe(base, { "fly-client-ip": "203.0.113.7" }), 200);
  assert.equal(await describe(base, { "fly-client-ip": "203.0.113.8" }), 200);
  assert.equal(await describe(base, { "fly-client-ip": "203.0.113.7" }), 429);
  // An IPv4-mapped IPv6 address is the same caller as the plain IPv4 one,
  // however it is spelled.
  for (const mapped of ["::ffff:203.0.113.8", "::FFFF:203.0.113.8", "::ffff:cb00:7108", "0:0:0:0:0:ffff:cb00:7108"]) {
    assert.equal(await describe(base, { "fly-client-ip": mapped }), 429, mapped);
  }
  // A different mapped address is a different caller, not one shared bucket.
  assert.equal(await describe(base, { "fly-client-ip": "::ffff:cb00:7109" }), 200);
});

test("a missing or malformed edge address falls back to one shared bucket", async (t) => {
  const { base } = await fixture(t, { clientIpHeader: "fly-client-ip", maxClientWorkPerHour: 1 });
  assert.equal(await describe(base), 200);
  assert.equal(await describe(base), 429);
  for (const forged of ["not-an-ip", "203.0.113.7, 198.51.100.1", "", "999.1.1.1"]) {
    assert.equal(await describe(base, { "fly-client-ip": forged }), 429, forged);
  }
});

test("an IPv6 caller is one client across its whole /64", async (t) => {
  const { base } = await fixture(t, { clientIpHeader: "fly-client-ip", maxClientWorkPerHour: 1 });
  assert.equal(await describe(base, { "fly-client-ip": "2001:db8:1:2::1" }), 200);
  for (const sibling of ["2001:db8:1:2::ffff", "2001:0db8:0001:0002:abcd:ef01:2345:6789", "2001:DB8:1:2:0:0:0:9"]) {
    assert.equal(await describe(base, { "fly-client-ip": sibling }), 429, sibling);
  }
  assert.equal(await describe(base, { "fly-client-ip": "2001:db8:1:3::1" }), 200);
  assert.equal(await describe(base, { "fly-client-ip": "::1" }), 200);
});

test("filling the client table evicts idle callers instead of locking everyone out", async (t) => {
  const { base } = await fixture(t, { clientIpHeader: "fly-client-ip", maxClients: 4, maxClientWorkPerHour: 1 });
  const ip = (i) => ({ "fly-client-ip": `198.51.100.${i}` });
  // Each caller spends its whole allowance, so a remembered caller answers 429.
  for (let i = 1; i <= 4; i += 1) assert.equal(await describe(base, ip(i)), 200, String(i));
  assert.equal(await describe(base, ip(2)), 429);
  // A fifth caller still gets in, and the oldest idle one is the one forgotten.
  assert.equal(await describe(base, ip(5)), 200);
  assert.equal(await describe(base, ip(1)), 200);
  for (let i = 10; i < 200; i += 1) {
    assert.equal((await fetch(base + "/api/status", { headers: ip(i) })).status, 200, String(i));
  }
});

test("eviction takes the least recently seen caller, and the global ceiling still holds", async (t) => {
  const { base } = await fixture(t, { clientIpHeader: "fly-client-ip", maxClients: 2, maxClientWorkPerHour: 1, maxWorkPerHour: 4 });
  const a = { "fly-client-ip": "203.0.113.1" }, b = { "fly-client-ip": "203.0.113.2" }, c = { "fly-client-ip": "203.0.113.3" };
  assert.equal(await describe(base, a), 200);
  assert.equal(await describe(base, b), 200);
  assert.equal((await fetch(base + "/api/status", { headers: a })).status, 200);
  assert.equal(await describe(base, c), 200);
  assert.equal(await describe(base, a), 429);
  // B was the oldest, so it was forgotten — and the hour's global ceiling caps it.
  assert.equal(await describe(base, b), 200);
  assert.equal(await describe(base, { "fly-client-ip": "203.0.113.4" }), 429);
});

test("a caller with a request in flight is never evicted", async (t) => {
  let release;
  const stalled = new Promise((resolve) => { release = resolve; });
  const { base } = await fixture(t, {
    clientIpHeader: "fly-client-ip", maxClients: 1,
    fetcher: async (url) => {
      if (url.pathname.endsWith("/next")) { await stalled; return new Response(null, { status: 204 }); }
      return new Response("{}");
    },
  });
  const pending = fetch(base + "/api/next", { headers: { "fly-client-ip": "203.0.113.1" } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  try { assert.equal((await fetch(base + "/api/status", { headers: { "fly-client-ip": "203.0.113.2" } })).status, 429); }
  finally { release(); await pending; }
  assert.equal((await fetch(base + "/api/status", { headers: { "fly-client-ip": "203.0.113.2" } })).status, 200);
});

test("POSTs need the page's Origin; GETs without one still play audio", async (t) => {
  const { base, seen } = await fixture(t);
  assert.equal((await fetch(base + "/api/show/describe", { method: "POST", body: "{}" })).status, 403);
  assert.equal((await fetch(base + "/api/show/describe", { method: "POST", body: "{}", headers: { origin: "https://other.example" } })).status, 403);
  assert.equal((await fetch(base + "/api/show/describe", { method: "POST", body: "{}", headers: { origin: "null" } })).status, 403);
  assert.equal(seen.length, 0);
  // A prefetching <audio> element sends no Origin header at all.
  const audio = await fetch(base + "/api/audio/seg_1/0?listener=l_test", { headers: { range: "bytes=0-2" } });
  assert.equal(audio.status, 206);
  assert.equal(audio.headers.get("access-control-allow-origin"), null);
  assert.equal(await describe(base), 200);
});
