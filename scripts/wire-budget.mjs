// Counts exactly how many metered NewsMCP calls one full show costs, by pointing
// the app at a local stub of the wire. Spends Claude and text-to-speech quota, but
// none of the scarce keyless news budget — which is the whole point.
//
// Run with: npm run wire-budget
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const calls = [];
const stub = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const rpc = JSON.parse(body || "{}");
    if (rpc.method === "notifications/initialized") {
      res.writeHead(202).end();
      return;
    }
    let result;
    if (rpc.method === "initialize") {
      result = { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "stub", version: "0" } };
      res.setHeader("mcp-session-id", "stub-session");
    } else if (rpc.params?.name === "check_limits") {
      result = {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              plan: "stub",
              retry_after: 0,
              calls_per_hour: { limit: 20, left: 20 - calls.length, reset_in: 1800 },
              max_concurrent: 1,
              lookback_days: 7,
              max_events: 20,
            }),
          },
        ],
      };
    } else if (rpc.params?.name === "news") {
      calls.push(rpc.params.arguments);
      result = { content: [{ type: "text", text: JSON.stringify(makeEvents(rpc.params.arguments)) }] };
    } else {
      result = { content: [{ type: "text", text: "{}" }] };
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result })}\n\n`);
  });
});

function makeEvents(args) {
  const now = new Date().toISOString();
  const events = Array.from({ length: 12 }, (_, i) => ({
    event_id: `evt_stub_${args.subject ? "call" : "wire"}_${i}`,
    headline: `Stub story ${i} about the port of Oakland`,
    abstract: `A synthesized test story number ${i}. Officials said little. Two agencies are reviewing it.`,
    entities: [{ name: "Port of Oakland", salience: 0.8 }],
    // Real national outlets and a real corroboration count: the screen that keeps
    // single-outlet local stories off the air applies to the stub too, and a stub
    // that cannot clear it would measure an episode with no subjects in it.
    sources: [`https://apnews.com/article/stub-${i}`, `https://www.reuters.com/stub-${i}`],
    event_type: "transport.logistics_disruption",
    content_type: "news_report",
    sector: "transport_logistics",
    confidence: 0.9,
    reports: 20 + i,
    newsrooms: 10 + i,
    first_seen: now,
    last_seen: now,
  }));
  return { total: events.length, events };
}

await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const stubUrl = `http://127.0.0.1:${stub.address().port}/mcp`;

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "newscast-wire-"));
const port = 4000 + Math.floor(Math.random() * 900);
const BASE = `http://127.0.0.1:${port}/api/`;

const child = spawn(process.execPath, ["server.js"], {
  env: { ...process.env, PORT: String(port), NEWSCAST_DATA_DIR: dataDir, NEWSMCP_URL: stubUrl },
  stdio: ["ignore", "pipe", "pipe"],
});
const logs = [];
for (const s of [child.stdout, child.stderr]) {
  s.setEncoding("utf8");
  s.on("data", (d) => {
    logs.push(d);
    if (process.env.VERBOSE) process.stdout.write(`    | ${d}`);
  });
}

let listener = null;
async function call(pathname, options = {}) {
  const res = await fetch(BASE + pathname, {
    ...options,
    headers: {
      ...(listener ? { "x-listener-id": listener } : {}),
      ...(options.body ? { "content-type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 204) return null;
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${pathname} -> ${res.status} ${json?.error ?? text}`);
  return json;
}

async function airSegment(segment, from = 0) {
  for (let i = from; ; i++) {
    if (!segment.turns[i]) {
      if (segment.complete) return;
      const more = await call(`segment/${segment.id}?from=${segment.turns.length}`);
      segment.turns.push(...more.turns);
      segment.complete = more.complete;
      if (!segment.turns[i]) continue;
    }
    await call("progress", { method: "POST", body: { segmentId: segment.id, turnIndex: i } });
  }
}

const mark = (label) => console.log(`  ${String(calls.length).padStart(2)} wire calls — ${label}`);

try {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await (await fetch(BASE + "status")).json()).newsmcp.reported) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  assert.equal(calls.length, 0, "check_limits must not be metered");
  mark("after boot (check_limits is free)");

  // A news podcast: the only kind that consults the metered wire at all.
  listener = (
    await call("show/define", { method: "POST", body: { presetId: "news" } })
  ).listenerId;
  await call("show/start", { method: "POST" });

  // Mirror the real client: start and the first two fetches race each other.
  const [opening] = await Promise.all([
    call("next?wait=45000"),
    call("show/start", { method: "POST" }),
    call("next?wait=45000"),
  ]);
  assert.equal(opening.kind, "opening");
  mark("after the opening");
  assert.equal(calls.length, 1, "the opening should cost exactly one headline pull");

  await airSegment(opening);
  const first = await call("next?wait=60000");
  assert.equal(first.kind, "topic");
  await airSegment(first);
  mark("after a researched segment (seeds are cached)");
  assert.equal(calls.length, 1, "a segment's own research must not touch the wire");

  const second = await call("next?wait=60000");
  await airSegment(second);
  mark("after a third segment");
  assert.equal(calls.length, 1, "still no re-pull");

  const submitted = await call("call/submit", {
    method: "POST",
    body: { question: "What is happening at the Port of Oakland this week?" },
  });
  await airSegment(await call(`segment/${submitted.jumpTo}`));
  const answer = await call(`segment/${submitted.answerSegmentId}?wait=40000`);
  await airSegment(answer);
  mark("after a call-in");
  assert.ok(calls.length <= 2, `a call-in should cost at most one wire call, total was ${calls.length}`);

  const after = await call("next?wait=90000");
  assert.ok(after, "the episode stalled after the call");
  await airSegment(after);
  mark("after resuming the episode");

  // A podcast that is not about the news must never reach the wire at all.
  const before = calls.length;
  listener = null; // a fresh listener, so this is genuinely a new podcast
  listener = (
    await call("show/define", {
      method: "POST",
      body: {
        about: "the history of Roman engineering",
        episodes: "one aqueduct, followed from quarry to collapse",
        angle: "says where the record is contested",
      },
    })
  ).listenerId;
  await call("show/start", { method: "POST" });
  await airSegment(await call("next?wait=45000"));
  await airSegment(await call("next?wait=90000"));
  mark("after a whole non-news episode");
  assert.equal(calls.length, before, "a history podcast spent a metered news call");

  console.log(`\nwire calls made: ${calls.length}`);
  for (const [i, args] of calls.entries()) console.log(`  ${i + 1}. ${JSON.stringify(args)}`);
  assert.ok(calls.length <= 2, `one show cost ${calls.length} wire calls; budget is 20 an hour`);
  console.log("\nPASS");
} catch (err) {
  console.error(`\nFAIL: ${err.message}`);
  console.error(`wire calls: ${JSON.stringify(calls, null, 1)}`);
  console.error(logs.join("").split("\n").slice(-20).join("\n"));
  process.exitCode = 1;
} finally {
  child.kill("SIGTERM");
  stub.close();
  await fs.rm(dataDir, { recursive: true, force: true });
}
