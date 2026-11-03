// The public page talks to this API-only gateway. The app and its keys stay
// behind it.
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

export function createGateway({
  upstream = "http://127.0.0.1:4310/api/",
  origin = "https://drop.jonomatus.ky",
  fetcher = fetch,
  maxBody = 12 * 1024 * 1024,
  maxWorkPerHour = 240,
  maxConcurrent = 6,
  maxConnections = 64,
  maxRequestsPerMinute = 6000,
  maxClientRequestsPerMinute = 600,
  maxClientWorkPerHour = 120,
  timeoutMs = 120000,
  readyTimeoutMs = 4000,
  // Where the hourly window survives a restart. Null keeps the whole budget in
  // memory, which is right on a laptop and wrong anywhere the process can be
  // restarted at will — see the note on the loader below.
  budgetFile = null,
  // The header the edge proxy writes with the caller's address, lowercased —
  // Fly sets fly-client-ip. Null keys clients on the socket address. Never name
  // a header the caller can write: X-Forwarded-For arrives with whatever the
  // caller put in it, and a key the caller chooses is a fresh budget per request.
  clientIpHeader = null,
  maxClients = 1024,
  now = Date.now,
} = {}) {
  const base = new URL(upstream);
  if (!base.pathname.endsWith("/")) throw new Error("Upstream must end in /");
  let windowStart = now(), workCount = 0, active = 0, connections = 0;
  let minuteStart = now(), requests = 0;
  const clients = new Map();
  // An hourly ceiling held only in memory is not a ceiling when the platform is
  // free to stop an idle machine: going quiet for a few minutes restarts the
  // process and hands back a full budget, so the real limit becomes "per burst"
  // and an hour holds as many bursts as the attacker has patience for. The
  // global window is therefore written through to disk. Per-client counters are
  // deliberately not: they bound one address, while this bounds the bill.
  if (budgetFile) {
    try {
      const saved = JSON.parse(fs.readFileSync(budgetFile, "utf8"));
      // Trust the saved window only while it is still the current hour, and
      // never let a corrupt or hostile file grant more budget than a fresh one.
      if (Number.isFinite(saved?.windowStart) && Number.isFinite(saved?.workCount) &&
          saved.windowStart <= now() && now() - saved.windowStart < 3600000) {
        windowStart = saved.windowStart;
        workCount = Math.max(0, Math.min(saved.workCount, maxWorkPerHour));
      }
    } catch {
      /* no usable budget on disk: start the hour here */
    }
  }
  const persist = () => {
    if (!budgetFile) return;
    try {
      fs.writeFileSync(`${budgetFile}.tmp`, JSON.stringify({ windowStart, workCount }));
      fs.renameSync(`${budgetFile}.tmp`, budgetFile);
    } catch {
      /* a budget we cannot write is still enforced in memory for this process */
    }
  };
  // An IPv6 caller usually holds a whole /64 and can pick any address in it, so
  // the /64 is the unit that identifies one caller.
  const clientKeyFor = (req) => {
    const header = clientIpHeader ? req.headers[clientIpHeader] : undefined;
    let address = typeof header === "string" ? header.trim() : "";
    // Absent or malformed means the edge did not vouch for an address, so fall
    // back to the socket. Behind a proxy that is the proxy itself, which pools
    // every such request into one shared bucket rather than a fresh one each.
    if (!net.isIP(address)) address = String(req.socket.remoteAddress || "unknown");
    if (!net.isIPv6(address)) return address;
    // Expand to eight numeric groups so every spelling of one address agrees:
    // case, zero runs, a zone id, or a trailing dotted IPv4.
    let text = address.split("%")[0].toLowerCase();
    const dotted = text.slice(text.lastIndexOf(":") + 1);
    if (net.isIPv4(dotted)) {
      const [a, b, c, d] = dotted.split(".").map(Number);
      text = `${text.slice(0, -dotted.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
    }
    const [head, tail = ""] = text.split("::");
    const left = head ? head.split(":") : [];
    const right = tail ? tail.split(":") : [];
    const groups = (text.includes("::")
      ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
      : left).map((g) => parseInt(g, 16));
    // An IPv4-mapped address is the IPv4 caller, however it is spelled.
    if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
      return [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join(".");
    }
    return `${groups.slice(0, 4).map((g) => g.toString(16)).join(":")}::/64`;
  };
  const reply = (res, status, error) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ error }));
  };
  return http.createServer(async (req, res) => {
    res.setHeader("vary", "Origin");
    res.setHeader("x-content-type-options", "nosniff");
    const requestOrigin = req.headers.origin;
    if (requestOrigin && requestOrigin !== origin) return reply(res, 403, "Origin not allowed");
    // Every browser sends Origin on a cross-origin POST, so a POST without one
    // did not come from the page. GETs stay open: a prefetching <audio> element
    // sends no Origin. This only turns away casual scripts — a caller outside a
    // browser can send any Origin it likes — so the budgets below are the limit.
    if (req.method === "POST" && requestOrigin !== origin) return reply(res, 403, "Origin not allowed");
    if (requestOrigin === origin) res.setHeader("access-control-allow-origin", origin);
    let url;
    try { url = new URL(req.url, "http://gateway.invalid"); }
    catch { return reply(res, 400, "Invalid request"); }
    if (url.pathname === "/health" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end('{"ok":true}');
    }
    // /health says this process is alive. Readiness has to mean more than that:
    // the platform keeps routing to whatever passes its check, so a gateway that
    // reported itself healthy while the app behind it was hung would hand every
    // visitor a 502. Neither path spends admission budget.
    if (url.pathname === "/ready" && req.method === "GET") {
      const probe = new AbortController();
      const probeTimer = setTimeout(() => probe.abort(), readyTimeoutMs);
      let ok = false;
      try {
        const upstreamResponse = await fetcher(new URL("status", base), {
          method: "GET", signal: probe.signal, redirect: "error",
        });
        await upstreamResponse.body?.cancel();
        ok = upstreamResponse.status < 500;
      } catch {
        ok = false;
      } finally {
        clearTimeout(probeTimer);
      }
      res.writeHead(ok ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify({ ok }));
    }
    // No static-file proxy, encoded separators, dot segments, or arbitrary host.
    if (!/^\/api\/[a-zA-Z0-9/_-]+$/.test(url.pathname)) return reply(res, 404, "Not found");
    if (req.method === "OPTIONS") {
      if (requestOrigin !== origin) return reply(res, 403, "Origin not allowed");
      res.writeHead(204, {
        "access-control-allow-methods": "GET, HEAD, POST, OPTIONS",
        "access-control-allow-headers": "content-type, x-listener-id, range",
        "access-control-max-age": "600",
      });
      return res.end();
    }
    if (!["GET", "HEAD", "POST"].includes(req.method)) return reply(res, 405, "Method not allowed");
    const route = url.pathname.slice(5);
    const polling = route === "next" && req.method === "GET";
    // Shared opens allocate a studio session and keep the normal admission cost.
    const archiveOperation = /^episodes\/[a-zA-Z0-9_-]+\/(?:open|share)$/.test(route);
    const doesWork = req.method === "POST" && !archiveOperation &&
      !["progress", "call/live", "call/cancel", "show/reset"].includes(route);
    const stamp = now();
    if (stamp - windowStart >= 3600000) { windowStart = stamp; workCount = 0; persist(); }
    if (stamp - minuteStart >= 60000) { minuteStart = stamp; requests = 0; }
    // Client limits supplement the global ceiling. They keep one caller from
    // spending everyone's hour; they are not an authentication boundary.
    const clientKey = clientKeyFor(req);
    for (const [key, value] of clients) {
      if (!value.active && stamp - value.hour >= 3600000) clients.delete(key);
    }
    let client = clients.get(clientKey);
    // Least recently seen first, so the oldest idle caller is the one to go.
    if (client) { clients.delete(clientKey); clients.set(clientKey, client); }
    const busy = () => {
      res.setHeader("retry-after", "60");
      res.setHeader("access-control-expose-headers", "retry-after");
      return reply(res, 429, "The studio is busy. Please try again shortly.");
    };
    if (!client) {
      // A full table must not turn every newcomer away, or filling it is a way
      // to take the studio down. Evicting an idle caller only forgets what that
      // caller spent, which the global ceiling still counts.
      if (clients.size >= maxClients) {
        for (const [key, value] of clients) {
          if (!value.active) { clients.delete(key); break; }
        }
        if (clients.size >= maxClients) return busy();
      }
      client = { minute: stamp, requests: 0, hour: stamp, work: 0, active: 0 };
      clients.set(clientKey, client);
    }
    if (stamp - client.minute >= 60000) { client.minute = stamp; client.requests = 0; }
    if (stamp - client.hour >= 3600000) { client.hour = stamp; client.work = 0; }
    requests += 1;
    client.requests += 1;
    if (requests > maxRequestsPerMinute || client.requests > maxClientRequestsPerMinute ||
        connections >= maxConnections || client.active >= 12) return busy();
    if ((doesWork || polling) && (workCount >= maxWorkPerHour || client.work >= maxClientWorkPerHour)) return busy();
    if (doesWork && active >= maxConcurrent) return busy();
    if (Number(req.headers["content-length"]) > maxBody) return reply(res, 413, "Recording is too large");
    connections += 1;
    client.active += 1;
    if (doesWork) active += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      // An aborted fetch cannot interrupt a client still uploading its body.
      if (!req.complete) req.destroy();
    }, timeoutMs);
    const abort = () => controller.abort();
    req.once("aborted", abort);
    res.once("close", abort);
    try {
      let body;
      if (req.method === "POST") {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > maxBody) return reply(res, 413, "Recording is too large");
          chunks.push(chunk);
        }
        body = Buffer.concat(chunks);
      }
      const target = new URL(route, base);
      if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname)) return reply(res, 400, "Invalid request");
      target.search = url.search;
      const headers = {};
      for (const key of ["content-type", "x-listener-id", "range"]) {
        if (typeof req.headers[key] === "string") headers[key] = req.headers[key];
      }
      if (doesWork) { workCount += 1; client.work += 1; persist(); }
      const upstreamResponse = await fetcher(target, {
        method: req.method, headers, body, signal: controller.signal, redirect: "error",
      });
      // Empty long polls neither spend generation budget nor occupy a work slot.
      // A delivered segment can trigger prefetch, so count successful deliveries.
      if (polling && upstreamResponse.status === 200) { workCount += 1; client.work += 1; persist(); }
      if (upstreamResponse.status >= 500) {
        await upstreamResponse.body?.cancel();
        return reply(res, 502, "The studio could not finish that request. Please try again.");
      }
      for (const key of ["content-type", "content-length", "content-range", "accept-ranges"]) {
        if (key === "content-length" && upstreamResponse.headers.has("content-encoding")) continue;
        const value = upstreamResponse.headers.get(key);
        if (value) res.setHeader(key, value);
      }
      res.setHeader("cache-control", "private, no-store");
      res.statusCode = upstreamResponse.status;
      if (req.method === "HEAD" || !upstreamResponse.body) res.end();
      else await pipeline(Readable.fromWeb(upstreamResponse.body), res);
    } catch {
      if (!res.headersSent && !res.destroyed) reply(res, controller.signal.aborted ? 504 : 502, "The studio could not be reached. Please try again.");
      else res.destroy();
    } finally {
      clearTimeout(timer);
      req.off("aborted", abort);
      res.off("close", abort);
      connections -= 1;
      client.active -= 1;
      if (doesWork) active -= 1;
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.NEWSCAST_PUBLIC_PORT || 4314);
  // Loopback by default: on a laptop something else terminates public HTTPS, and
  // a gateway that bound every interface by accident would be the whole point
  // missed. A container sets this explicitly, because there its address is the edge.
  const host = process.env.NEWSCAST_PUBLIC_HOST || "127.0.0.1";
  // The admission ceiling is the only thing between an unauthenticated page and
  // the provider bill, so it is tunable without a deploy. Defaults are the
  // values the laptop instance ran with. "Finite and non-negative" is not a
  // ceiling: 1e308 parses as a number and lifts the limit past any real traffic,
  // so the accepted range is a whole number with an explicit upper bound.
  const MAX_BUDGET = 100000;
  const budget = (name, fallback) => {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === "") return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0 || value > MAX_BUDGET) {
      throw new Error(`${name} must be a whole number between 0 and ${MAX_BUDGET}`);
    }
    return value;
  };
  createGateway({
    upstream: process.env.NEWSCAST_PUBLIC_UPSTREAM || "http://127.0.0.1:4310/api/",
    origin: process.env.NEWSCAST_PUBLIC_ORIGIN || "https://drop.jonomatus.ky",
    maxWorkPerHour: budget("NEWSCAST_PUBLIC_MAX_WORK_PER_HOUR", 240),
    maxClientWorkPerHour: budget("NEWSCAST_PUBLIC_MAX_CLIENT_WORK_PER_HOUR", 120),
    budgetFile: process.env.NEWSCAST_PUBLIC_BUDGET_FILE || null,
    clientIpHeader: process.env.NEWSCAST_PUBLIC_CLIENT_IP_HEADER?.trim().toLowerCase() || null,
  }).listen(port, host, () => console.log(`Public API gateway listening on ${host}:${port}`));
}
