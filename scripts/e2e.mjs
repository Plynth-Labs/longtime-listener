// Live end-to-end drive against real research, Claude, and speech.
// Spends real quota. Run with: npm run e2e
//
// Two podcasts are driven, because the point of this version is that the news is
// one preset and not the product: a custom subject with no wire behind it has to
// work exactly as well as the news does.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "newscast-e2e-"));
const port = 4000 + Math.floor(Math.random() * 900);
const BASE = `http://127.0.0.1:${port}/api/`;

const child = spawn(process.execPath, ["server.js"], {
  env: { ...process.env, PORT: String(port), NEWSCAST_DATA_DIR: dataDir },
  stdio: ["ignore", "pipe", "pipe"],
});
const logs = [];
for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", (d) => {
    logs.push(d);
    if (process.env.E2E_VERBOSE) process.stdout.write(`    | ${d}`);
  });
}

let listener = null;
async function call(pathname, options = {}) {
  const res = await fetch(BASE + pathname, {
    ...options,
    headers: {
      ...(listener ? { "x-listener-id": listener } : {}),
      ...(options.body && !options.raw ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
    body: options.raw ?? (options.body ? JSON.stringify(options.body) : undefined),
  });
  if (res.status === 204) return null;
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${pathname} -> ${res.status} ${json?.error ?? text}`);
  return json;
}

async function waitForServer() {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(BASE + "status");
      if ((await res.json()).ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server never came up:\n${logs.join("")}`);
}

const started = Date.now();
const t = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
const step = (msg) => console.log(`[${t()}] ${msg}`);

/** Play a segment for real: fetch each turn's mp3 and report progress. */
async function airSegment(segment, { maxTurns = 99, from = 0 } = {}) {
  let i = from;
  for (; i < from + maxTurns; i++) {
    if (!segment.turns[i]) {
      if (segment.complete) break;
      const more = await call(`segment/${segment.id}?from=${segment.turns.length}`);
      segment.turns.push(...more.turns);
      segment.complete = more.complete;
      segment.sources = more.sources ?? segment.sources;
      if (!segment.turns[i]) {
        if (segment.complete) break;
        continue;
      }
    }
    const res = await fetch(`${BASE}audio/${segment.id}/${i}`, { headers: { "x-listener-id": listener } });
    assert.ok(res.ok, `audio ${segment.id}/${i} -> ${res.status}`);
    const bytes = (await res.arrayBuffer()).byteLength;
    assert.ok(bytes > 2000, `turn ${i} rendered only ${bytes} bytes`);
    await call("progress", { method: "POST", body: { segmentId: segment.id, turnIndex: i } });
  }
  return i;
}

const spoken = (segment) => segment.turns.map((x) => x.text).join(" ");

async function drain(id) {
  let seg = await call(`segment/${id}`);
  while (!seg.complete) seg = await call(`segment/${id}?from=${seg.turnCount}`);
  return call(`segment/${id}`);
}

try {
  await waitForServer();
  step("server up");

  /* ---- 1. a podcast about something that is not the news ---- */
  const defined = await call("show/define", {
    method: "POST",
    body: {
      about: "spaceflight and the machines we have sent out of the solar system",
      episodes: "one spacecraft or mission, worked through properly",
      angle: "takes the engineering seriously — power budgets, instruments, orbits",
    },
  });
  listener = defined.listenerId;
  assert.equal(defined.show.useWire, false, "a custom subject reached for the metered news wire");
  step(`podcast: "${defined.show.title}" (${defined.show.families.join(", ") || "open web"})`);

  await call("show/start", { method: "POST" });

  // Racing start against the first fetch is the real client's behaviour: setup
  // fires show/start and the show loop asks for a segment immediately behind it.
  const firstAt = Date.now();
  const [opening, , alsoOpening] = await Promise.all([
    call("next?wait=45000"),
    call("show/start", { method: "POST" }),
    call("next?wait=45000"),
  ]);
  assert.ok(opening, "no opening segment");
  assert.equal(opening.kind, "opening");
  assert.ok(opening.turns.length >= 1, "opening delivered with no turns");
  step(`opening in ${((Date.now() - firstAt) / 1000).toFixed(1)}s — the welcome, before any research`);
  for (const turn of opening.turns) console.log(`        ${turn.name}: ${turn.text}`);
  assert.equal(alsoOpening.id, opening.id, "concurrent fetches got different segments");

  /* ---- 2. delivery is not playback ---- */
  let profile = await call("profile");
  assert.equal(profile.coveredCount, 0, "a subject was marked covered before it aired");
  const redelivered = await call("next?wait=5000");
  assert.equal(redelivered.id, opening.id, "an undelivered segment was skipped");
  assert.equal(redelivered.resumeFrom, 0, "resumed past turns nobody heard");
  step("undelivered segment re-offered rather than skipped — ok");

  await airSegment(opening, { maxTurns: 1 });
  const resumed = await call("next?wait=20000");
  assert.equal(resumed.id, opening.id, "a half-played segment was abandoned on reconnect");
  assert.equal(resumed.resumeFrom, 1, `expected to resume at turn 1, got ${resumed.resumeFrom}`);
  step("reconnect resumes the same segment mid-way — ok");
  await airSegment(resumed, { from: resumed.resumeFrom });

  /* ---- 3. a researched segment, with its own sources ---- */
  const researchedAt = Date.now();
  const first = await call("next?wait=90000");
  assert.ok(first, "nothing queued after the opening");
  assert.equal(first.kind, "topic");
  step(`researched segment in ${((Date.now() - researchedAt) / 1000).toFixed(1)}s: "${first.title}"`);
  await airSegment(first, { maxTurns: 2 });

  const full = await drain(first.id);
  assert.ok(full.sources.length > 0, "a researched segment cited no sources");
  step(`sources: ${full.sources.map((s) => s.name).join(", ")}`);
  const text = spoken(full);
  assert.equal(/https?:\/\//.test(text), false, "a URL was written into spoken dialogue");
  assert.equal(/\]\(/.test(text), false, "a markdown citation marker reached the script");
  // Coverage counts screen stories on the way in; they are never something the
  // hosts say, because they are not a fact about the world.
  assert.equal(
    /\b(newsrooms?|outlets)\b[^.]{0,40}\b(carr|cover|report)/i.test(text),
    false,
    `the hosts counted the coverage: ${text.slice(0, 200)}`,
  );
  await airSegment(full, { from: 2 });
  profile = await call("profile");
  assert.ok(profile.coveredCount >= 1, "an aired subject was never marked covered");

  /* ---- 4. the caller flow: board, invitation, question, answer ---- */
  const queued = await call("next?wait=90000");
  assert.ok(queued, "nothing queued to interrupt");
  await airSegment(queued, { maxTurns: 1 });

  const board = await call("call/start", { method: "POST" });
  assert.equal(board.call.status, "queued");
  const invitation = await call(`segment/${board.jumpTo}`);
  assert.equal(invitation.bridgeRole, "handoff");
  assert.ok(invitation.complete && invitation.turns.length >= 1, "the invitation was not ready instantly");
  assert.match(invitation.turns[0].text, /caller/i, "the hosts never handed over");
  step(`invitation ready instantly: "${invitation.turns[0].text}"`);
  await airSegment(invitation);
  await call("call/live", { method: "POST" });

  // A double tap must not open a second call.
  const again = await call("call/start", { method: "POST" });
  assert.equal(again.call.id, board.call.id, "a second tap opened a second call");

  const question = "How is Voyager 1 still transmitting, and how much power has it got left?";
  const submitAt = Date.now();
  const submitted = await call("call/submit", { method: "POST", body: { question } });
  step(`question handed over in ${((Date.now() - submitAt) / 1000).toFixed(1)}s`);

  const hold = await call(`segment/${submitted.jumpTo}`);
  assert.equal(hold.bridgeRole, "hold");
  assert.ok(hold.complete && hold.turns.length >= 1, "nothing to play while the research ran");
  const holdAudio = await fetch(`${BASE}audio/${hold.id}/0`, { headers: { "x-listener-id": listener } });
  assert.ok(holdAudio.ok, "hold-line audio missing");
  await airSegment(hold);

  // The subject queued before the call must be gone, not merely deferred.
  const dropped = await call(`segment/${queued.id}?wait=0`).catch(() => null);
  assert.ok(dropped === null || dropped.cancelled || dropped.abandoned, "the pre-call lookahead survived");
  step("queued pre-call subject discarded — ok");

  const answerAt = Date.now();
  const answer = await call(`segment/${submitted.answerSegmentId}`);
  assert.equal(answer.kind, "caller");
  assert.equal(answer.callerQuestion, question, "the transcript lost what the caller said");
  assert.ok(answer.turns.length >= 1, "caller answer had no turns");
  step(`answer first turn ${((Date.now() - answerAt) / 1000).toFixed(1)}s after the hold line started`);
  for (const turn of answer.turns.slice(0, 3)) console.log(`        ${turn.name}: ${turn.text}`);
  await airSegment(answer, { maxTurns: 2 });

  const fullAnswer = await drain(answer.id);
  assert.ok(fullAnswer.sources.length > 0, "the answer cited no sources");
  assert.equal(/https?:\/\//.test(spoken(fullAnswer)), false, "a URL reached the spoken answer");
  step(`answer cites ${fullAnswer.sources.length}: ${fullAnswer.sources.map((s) => s.name).join(", ")}`);

  const stillOnTheCall = await call("next?wait=20000");
  assert.equal(stillOnTheCall.id, answer.id, "the caller was cut off mid-answer");
  await airSegment(stillOnTheCall, { from: stillOnTheCall.resumeFrom });

  /* ---- 5. the episode is re-planned around the call, with fresh research ---- */
  const followOn = await call("next?wait=120000");
  assert.ok(followOn, "nothing queued after the call");
  assert.equal(followOn.kind, "topic", `expected a subject after the call, got ${followOn.kind}`);
  assert.notEqual(followOn.id, queued.id, "the episode snapped back to the discarded subject");
  step(`episode continues with: "${followOn.title}"`);
  await airSegment(followOn, { maxTurns: 2 });
  const followFull = await call(`segment/${followOn.id}`);
  assert.ok(followFull.sources.length > 0, "the follow-on segment was not researched");
  step(`follow-on researched independently: ${followFull.sources.map((s) => s.name).join(", ")}`);

  /* ---- 6. the profile learns from the call and nothing else ---- */
  const learned = await call("profile");
  assert.ok(learned.callIns.length >= 1, "the call was not written to the profile");
  assert.equal(learned.callIns[0].text, question, "the wrong call text was stored");
  const all = [...learned.interests.topics, ...learned.interests.entities];
  for (const row of all) {
    assert.notEqual(row.source, "legacy", `an interest arrived with no explanation: ${row.label}`);
    assert.ok(row.why, `no provenance for ${row.label}`);
  }
  // Every name learned has to be a name the caller actually said.
  const said = ` ${question.toLowerCase().replace(/[^a-z0-9 ]+/g, " ")} `;
  for (const row of learned.interests.entities) {
    const parts = row.label.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2);
    assert.ok(
      parts.length && parts.every((w) => said.includes(` ${w} `)),
      `learned "${row.label}" — the caller never said it`,
    );
  }
  step(`profile learned: ${all.map((r) => `${r.label} (${r.source})`).join(", ") || "nothing"}`);

  /* ---- 7. pacing ---- */
  const onAir = await call("next?wait=120000");
  const deeper = await call("pace", { method: "POST", body: { segmentId: onAir.id, action: "deeper" } });
  assert.equal(deeper.pacing, 1, "dive deeper did not move the pace");
  const status = await call("status");
  assert.match(status.show.planned[0] ?? "", /further in/i, "no deeper pass was queued");
  step(`"dive deeper" queued: ${status.show.planned[0]}`);

  const hurried = await call("pace", { method: "POST", body: { segmentId: onAir.id, action: "hurry" } });
  assert.equal(hurried.pacing, 0, "hurry up did not move the pace back");
  const cut = await call(`segment/${onAir.id}?wait=0`);
  assert.ok(cut.abandoned, "hurry up did not cut the segment short");
  const afterHurry = await call("profile");
  assert.equal(
    afterHurry.interests.entities.length,
    learned.interests.entities.length,
    "hurrying the hosts along taught the profile a dislike of someone",
  );
  step("hurry up shortened the pace and learned nothing about people — ok");

  /* ---- 8. a new premise voids the old episode ---- */
  await call("show/define", { method: "POST", body: { presetId: "news" } });
  const fresh = await call("next?wait=60000");
  assert.equal(fresh.kind, "opening", "a new premise kept playing the old episode");
  assert.notEqual(fresh.id, opening.id);
  const newStatus = await call("status");
  assert.equal(newStatus.show.show.useWire, true, "the news preset did not enable the wire");
  step(`new premise, new episode: "${newStatus.show.show.title}"`);

  const wire = newStatus.newsmcp;
  step(`newsmcp budget: ${wire.remaining}/${wire.hourly} left, reserve ${wire.reserve}`);
  console.log(`\nPASS — end to end in ${t()}`);
} catch (err) {
  console.error(`\nFAIL: ${err.message}`);
  console.error(logs.join("").split("\n").slice(-25).join("\n"));
  process.exitCode = 1;
} finally {
  child.kill("SIGTERM");
  await fs.rm(dataDir, { recursive: true, force: true });
}
