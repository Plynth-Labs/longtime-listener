import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.NEWSCAST_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "newscast-topic-test-"));
process.env.NEWSMCP_URL = "http://127.0.0.1:1/mcp";
process.env.OPENAI_BASE_URL = "http://127.0.0.1:1/v1";
process.env.WIKIPEDIA_API_URL = "http://127.0.0.1:1/w/api.php";
process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:1";
process.env.ANTHROPIC_API_KEY = "test";
process.env.OPENAI_API_KEY = "test";

const {
  defineShow,
  episodeOutlinePlan,
  firstEpisodeResearchSubject,
  nextEpisodeDefinition,
  normalizeEpisodeOutline,
} = await import("../src/showdef.js");
const {
  CALL_IN_REMINDER_FIRST_SECONDS,
  CALL_IN_REMINDER_REPEAT_SECONDS,
  Show,
  ShowRegistry,
  callInReminderDue,
  countedHeardSeconds,
} = await import("../src/show.js");

const supplied = [
  "Why the guidance computer had so little memory",
  "How priority scheduling protected the lunar landing",
  "What the 1202 alarm told the crew",
  "Which design choices survived into later spacecraft",
];
const showDefinition = defineShow({
  about: "the Apollo moon landing",
  episodeTitle: "A Computer With No Room to Spare",
  episodeBrief: "How the Apollo Guidance Computer kept the landing alive under pressure.",
  episodeFocus: "the Apollo Guidance Computer during the lunar descent",
  episodeOutline: supplied,
});
assert.deepEqual(showDefinition.episodeOutline, supplied, "a valid outline changed during validation");

const padded = normalizeEpisodeOutline(["One real beat", { bad: true }, "One real beat"], {
  about: "volcanoes",
  episodeFocus: "how volcanic eruptions are forecast",
});
assert.equal(padded.length, 3);
assert.equal(padded[0], "One real beat");
assert.equal(padded.some((beat) => beat.includes("[object Object]")), false);

const longBeat =
  "How early workshops organized skilled labor while printers financed paper, type, presses, " +
  "distribution, and the uncertain market for printed books across distant cities";
const shortened = normalizeEpisodeOutline([longBeat, "Second useful beat", "Third useful beat"])[0];
assert.ok(shortened.length <= 140);
assert.equal(shortened.endsWith("…"), true);
const shortenedStem = shortened.slice(0, -1);
assert.equal(longBeat.startsWith(shortenedStem), true);
assert.equal(longBeat[shortenedStem.length], " ", "an oversized outline beat was cut midword");

const plan = episodeOutlinePlan(showDefinition);
assert.deepEqual(plan.map((item) => item.title), supplied);
assert.equal(firstEpisodeResearchSubject(showDefinition), plan[0].query);
for (const item of plan) {
  assert.match(item.query, /Apollo moon landing/i);
  assert.match(item.query, /Apollo Guidance Computer/i);
}

const next = nextEpisodeDefinition(showDefinition, {
  episodeTitle: "The Engine That Had to Throttle",
  episodeBrief: "How the lunar module descent engine controlled the final approach.",
  episodeFocus: "the lunar module descent engine",
  episodeOutline: ["The throttle problem", "The injector design", "The final descent burn"],
});
assert.deepEqual(next.episodeOutline, ["The throttle problem", "The injector design", "The final descent burn"]);

assert.equal(countedHeardSeconds({ phase: "started", heardSeconds: 40 }), 0);
assert.equal(countedHeardSeconds({ phase: "skipped", heardSeconds: 40 }), 0);
assert.equal(countedHeardSeconds({ phase: "finished", heardSeconds: 40, alreadyCounted: true }), 0);
assert.equal(countedHeardSeconds({ phase: "finished", heardSeconds: Number.POSITIVE_INFINITY }), 0);
assert.equal(countedHeardSeconds({ phase: "finished", heardSeconds: 40 }), 40);

assert.equal(callInReminderDue({
  heardSeconds: CALL_IN_REMINDER_FIRST_SECONDS - 1,
  atBoundary: true,
}), false);
assert.equal(callInReminderDue({
  heardSeconds: CALL_IN_REMINDER_FIRST_SECONDS,
  atBoundary: false,
}), false);
assert.equal(callInReminderDue({
  heardSeconds: CALL_IN_REMINDER_FIRST_SECONDS,
  atBoundary: true,
}), true);
assert.equal(callInReminderDue({
  heardSeconds: CALL_IN_REMINDER_FIRST_SECONDS + CALL_IN_REMINDER_REPEAT_SECONDS - 1,
  lastReminderAtSeconds: CALL_IN_REMINDER_FIRST_SECONDS,
  atBoundary: true,
}), false);
assert.equal(callInReminderDue({
  heardSeconds: CALL_IN_REMINDER_FIRST_SECONDS + CALL_IN_REMINDER_REPEAT_SECONDS,
  lastReminderAtSeconds: CALL_IN_REMINDER_FIRST_SECONDS,
  atBoundary: true,
}), true);
assert.equal(callInReminderDue({
  heardSeconds: 10_000,
  hasCalled: true,
  atBoundary: true,
}), false);

// Drive the public progress seam to prove only real, unique, finished turns move
// the listening clock and that the reminder is inserted after the whole segment.
const show = new Show("outline-reminder-test");
show.def = showDefinition;
show.scope = "sc_test";
show.started = false;
const segment = {
  id: "seg_test",
  kind: "topic",
  title: supplied[0],
  turns: [{ text: "First line." }, { text: "Second line." }],
  complete: true,
  cancelled: false,
  abandoned: false,
  aired: false,
  airedThrough: -1,
  coverKeys: [],
  cancel() {
    this.cancelled = true;
  },
};
show.segments.push(segment);
show.deliveredThrough = 0;
show.reportProgress({ segmentId: segment.id, turnIndex: 0, phase: "started", heardSeconds: 299 });
show.reportProgress({ segmentId: segment.id, turnIndex: 0, phase: "skipped", heardSeconds: 299 });
assert.equal(show.heardSeconds, 0);
show.reportProgress({ segmentId: segment.id, turnIndex: 0, phase: "finished", heardSeconds: 299 });
show.reportProgress({ segmentId: segment.id, turnIndex: 0, phase: "finished", heardSeconds: 299 });
show.reportProgress({ segmentId: segment.id, turnIndex: 99, phase: "finished", heardSeconds: 999 });
assert.equal(show.heardSeconds, 299);
assert.equal(show.segments.some((item) => item.bridgeRole === "call-reminder"), false);
show.reportProgress({ segmentId: segment.id, turnIndex: 1, phase: "finished", heardSeconds: 2 });
assert.equal(show.heardSeconds, 301);
assert.equal(show.segments[1].bridgeRole, "call-reminder");

show.queueCall();
assert.equal(show.hasCalled, true);
assert.equal(show.segments.some((item) => item.bridgeRole === "call-reminder"), false);

show.reset();
assert.equal(show.heardSeconds, 0);
assert.equal(show.lastCallReminderAtSeconds, null);
assert.equal(show.hasCalled, false);

let now = 0;
const made = new Map();
const registry = new ShowRegistry({
  max: 2,
  idleMs: 100,
  now: () => now,
  create: (id) => {
    const value = { id, resetCalled: false, reset() { this.resetCalled = true; } };
    made.set(id, value);
    return value;
  },
  isActive: () => false,
});
registry.get("oldest");
now = 25;
registry.get("newer");
now = 125;
registry.get("admitted");
assert.equal(made.get("oldest").resetCalled, true);
assert.deepEqual(registry.values().map((item) => item.id), ["newer", "admitted"]);

const full = new ShowRegistry({ max: 1, idleMs: 0, create: (id) => ({ id }), isActive: () => true });
full.get("active");
assert.throws(() => full.get("rejected"), (err) => err.status === 503 && err.code === "SHOW_CAPACITY");

const showSource = await fs.readFile(new URL("../src/show.js", import.meta.url), "utf8");
const submitCall = showSource.slice(showSource.indexOf("async submitCall("));
const snapshotAt = submitCall.indexOf("const brief = profiles.brief(profile");
const recordAt = submitCall.indexOf(".recordCallIn(");
const coverAt = submitCall.indexOf("scriptCallerCover(");
assert.ok(snapshotAt >= 0 && snapshotAt < recordAt, "the current call leaked into its own prior-call brief");
assert.ok(recordAt < coverAt, "the accepted call was not persisted before cover scripting began");

console.log("topic engine tests passed");
