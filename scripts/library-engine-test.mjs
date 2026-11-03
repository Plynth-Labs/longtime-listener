import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EpisodeStore } from "../src/episodes.js";
import { coveredTitlesFromPrefix, Segment, Show } from "../src/show.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "newscast-library-"));
const audioDir = path.join(root, "captured-audio");
await fs.mkdir(audioDir, { recursive: true });

const definition = {
  seriesId: "series_test",
  episodeId: "episode_source",
  title: "Thinking Machines, In Order",
  brief: "A history of computing.",
  about: "the history of computing",
  episodes: "one development at a time",
  angle: "plain chronology",
  episodeTitle: "Ten Men, One Summer",
  episodeBrief: "How a small team built an early computer.",
  episodeFocus: "the first stored program",
  episodeOutline: ["The team forms", "The machine takes shape", "The first program runs"],
  episodeNumber: 1,
  episodeHistory: [{ episodeTitle: "Private draft", episodeBrief: "Never shared" }],
  families: ["reference"],
  useWire: false,
};

const keys = [crypto.randomBytes(16).toString("hex"), crypto.randomBytes(16).toString("hex")];
await Promise.all(keys.map((key, index) => fs.writeFile(path.join(audioDir, `${key}.mp3`), `audio-${index}`)));

const liveSnapshot = {
  schema: 1,
  listenerId: "listener_owner",
  def: definition,
  segments: [
    {
      view: {
        id: "seg_opening",
        kind: "opening",
        title: definition.episodeTitle,
        turns: [
          { speaker: "ari", name: "Ari", text: "Welcome.", audioKey: keys[0] },
          { speaker: "dev", name: "Dev", text: "Let's begin.", audioKey: keys[1] },
        ],
        complete: true,
      },
      why: "private listener preference",
      planItem: { title: "private plan", why: "profile-derived" },
      aired: true,
      airedThrough: 0,
      createdAt: 1,
    },
  ],
  plan: [{ title: "unpublished", why: "profile-derived" }],
  covered: [definition.episodeTitle],
  deliveredThrough: 0,
  heardTurns: ["Welcome."],
  heardTurnKeys: ["seg_opening:0"],
  heardSeconds: 4,
};

const store = new EpisodeStore({ dataDir: path.join(root, "data") });
const imported = await store.importLiveSnapshot("listener_owner", liveSnapshot, { audioDir });
assert.match(imported.id, /^ep_[a-f0-9]{20}$/);
assert.equal((await store.podcasts("listener_owner"))[0].episodes[0].episodeTitle, "Ten Men, One Summer");
assert.equal(await store.load("listener_other", imported.id), null, "another listener cannot open it");
assert.equal(
  await fs.readFile(path.join(root, "data", "cache", "tts", `${keys[0]}.mp3`), "utf8"),
  "audio-0",
  "captured audio is copied byte-for-byte",
);

const importedAgain = await store.importLiveSnapshot("listener_owner", liveSnapshot, { audioDir });
assert.equal(importedAgain.id, imported.id, "re-import updates the captured episode without duplicating it");

const newer = structuredClone(importedAgain);
newer.state.segments[0].turns.push({
  speaker: "ari",
  name: "Ari",
  text: "A second saved line.",
  audio: keys[0],
});
const saving = store.save("listener_owner", newer);
const [sharedA, sharedB] = await Promise.all([
  store.share("listener_owner", imported.id),
  store.share("listener_owner", imported.id),
  saving,
]).then((values) => values.slice(0, 2));
assert.equal(sharedA.shareId, sharedB.shareId, "concurrent shares reuse one frozen capability");
assert.match(sharedA.shareId, /^share_[a-f0-9]{36}$/, "share capabilities have 144 bits of entropy");
assert.equal(sharedA.record.state.segments[0].turns.length, 3, "share waits for an earlier streamed save");
assert.deepEqual(sharedA.record.definition.episodeHistory, [], "unshared episode history stays private");
assert.deepEqual(sharedA.record.state.plan, [], "unpublished planning stays private");
assert.equal(sharedA.record.state.segments[0].planItem, null);

const replay = new Show("listener_replay", { episodeStore: store });
const sharedWithGap = structuredClone(sharedA.record);
sharedWithGap.state.segments.unshift({
  id: "seg_cancelled",
  kind: "topic",
  title: "Never aired",
  turns: [],
  complete: true,
  cancelled: true,
  airedThrough: -1,
});
await replay.openArchive(sharedWithGap, { from: "start", shared: true, shareId: sharedA.shareId });
assert.equal(replay.status().show.replay, true);
assert.equal(replay.status().show.shared, true);
let next = await replay.next({ timeoutMs: 0 });
assert.equal(next.segment.id, "seg_opening", "cancelled and empty archive gaps do not hide later audio");
assert.equal(next.resumeFrom, 0);
for (let index = 0; index < next.segment.turns.length; index += 1) {
  await replay.reportProgress({ segmentId: next.segment.id, turnIndex: index, phase: "finished", heardSeconds: 1 });
}
next = await replay.next({ timeoutMs: 0 });
assert.equal(next, null);
assert.equal(replay.playbackComplete(), true, "sealed replay reaches a durable end without scripting");
assert.equal((await store.list("listener_replay")).length, 0, "shared playback never mutates an archive");

const interruptedRecord = structuredClone(sharedA.record);
interruptedRecord.id = "ep_other_saved_episode";
interruptedRecord.state.segments[0].abandoned = true;
interruptedRecord.state.segments[0].airedThrough = 0;
const interruptedReplay = new Show("listener_interrupted", { episodeStore: store });
await interruptedReplay.openArchive(interruptedRecord, { from: "start", shared: true });
const interrupted = await interruptedReplay.next({ timeoutMs: 0 });
assert.equal(interrupted.segment.turns.length, 1, "an interrupted segment replays only its heard prefix");

let releaseFork;
const discarded = [];
const stalledStore = {
  save: (_listenerId, snapshot) => new Promise((resolve) => {
    releaseFork = () => resolve({ ...snapshot, id: snapshot.id });
  }),
  remove: async (_listenerId, id) => discarded.push(id),
};
const racing = new Show("listener_race", { episodeStore: stalledStore });
await racing.openArchive(sharedA.record, { from: "start", shared: true });
racing.queueCall();
const firstSubmit = racing.submitCall({ question: "What did the machine do?" });
await assert.rejects(
  racing.submitCall({ question: "Submit the same call twice" }),
  (err) => err.code === "CALL_ALREADY_SUBMITTED",
  "a stalled fork is claimed before a duplicate submit can create another one",
);
await racing.openArchive(interruptedRecord, { from: "start", shared: true });
releaseFork();
await assert.rejects(
  firstSubmit,
  (err) => err.code === "STALE_FORK",
  "a fork finishing after another episode opens cannot replace it",
);
assert.equal(discarded.length, 1, "the stale branch record is discarded");
assert.equal(racing.status().show.episodeId, interruptedRecord.id);

let releaseCancelledFork;
const cancelledDiscards = [];
const cancelStore = {
  save: (_listenerId, snapshot) => new Promise((resolve) => {
    releaseCancelledFork = () => resolve({ ...snapshot, id: snapshot.id });
  }),
  remove: async (_listenerId, id) => cancelledDiscards.push(id),
};
const cancelledRace = new Show("listener_cancel_race", { episodeStore: cancelStore });
await cancelledRace.openArchive(sharedA.record, { from: "start", shared: true });
cancelledRace.queueCall();
const cancelledSubmit = cancelledRace.submitCall({ question: "Will this be cancelled?" });
cancelledRace.cancelCall();
releaseCancelledFork();
await assert.rejects(cancelledSubmit, (err) => err.code === "STALE_FORK");
assert.equal(cancelledDiscards.length, 1, "cancelling while a fork saves leaves no branch behind");

const phantomWrites = [];
const phantomStore = {
  save: async (_listenerId, snapshot) => {
    phantomWrites.push(structuredClone(snapshot));
    return snapshot;
  },
};
const noPhantom = new Show("listener_no_phantom", { episodeStore: phantomStore });
noPhantom.def = definition;
noPhantom.archiveEpisodeId = "ep_existing_saved_episode";
await noPhantom.archiveNow();
noPhantom.reset();
await noPhantom.archiveNow();
await noPhantom.openArchive(sharedA.record, { from: "start", shared: true });
assert.equal(phantomWrites.length, 1, "reset then open never archives an empty copy of the old definition");

const immutableSource = structuredClone(interruptedRecord);
immutableSource.id = "ep_immutable_content";
immutableSource.state.segments[0].turns = sharedA.record.state.segments[0].turns;
immutableSource.state.segments[0].abandoned = true;
immutableSource.state.segments[0].airedThrough = 0;
const sealed = await store.save("listener_content_owner", immutableSource);
const ownerReplay = new Show("listener_content_owner", { episodeStore: store });
await ownerReplay.openArchive(sealed, { from: "start" });
const ownerFirst = await ownerReplay.next({ timeoutMs: 0 });
assert.equal(ownerFirst.segment.turns.length, 1);
await ownerReplay.reportProgress({
  segmentId: ownerFirst.segment.id,
  turnIndex: 0,
  phase: "finished",
  heardSeconds: 2,
});
const contentAfterReplay = await store.load("listener_content_owner", sealed.id);
assert.equal(contentAfterReplay.state.segments[0].turns.length, 3, "owner replay cannot truncate sealed content");
assert.equal(contentAfterReplay.state.segments[0].abandoned, true, "presentation sealing stays out of content");
assert.equal(contentAfterReplay.playback.segments[0].airedThrough, 0, "resume progress is stored separately");

const cancelSource = structuredClone(sharedA.record);
cancelSource.id = "ep_cancel_resume_source";
cancelSource.state.segments.push({
  ...structuredClone(cancelSource.state.segments[0]),
  id: "seg_following",
  title: "Following subject",
  turns: cancelSource.state.segments[0].turns.slice(0, 1),
  aired: false,
  airedThrough: -1,
});
cancelSource.state.segments[0].aired = false;
cancelSource.state.segments[0].airedThrough = -1;
cancelSource.playback = null;
const cancelSaved = await store.save("listener_cancel_owner", cancelSource);
const cancelReplay = new Show("listener_cancel_owner", { episodeStore: store });
await cancelReplay.openArchive(cancelSaved, { from: "start" });
const beforeCall = await cancelReplay.next({ timeoutMs: 0 });
await cancelReplay.reportProgress({
  segmentId: beforeCall.segment.id,
  turnIndex: 0,
  phase: "finished",
  heardSeconds: 10,
});
const realFetch = globalThis.fetch;
const realWarn = console.warn;
globalThis.fetch = async () => { throw new Error("offline bridge render"); };
console.warn = () => {};
cancelReplay.queueCall();
const invitation = cancelReplay.inviteCaller();
const handoff = cancelReplay.segment(invitation.jumpTo);
await cancelReplay.reportProgress({
  segmentId: handoff.id,
  turnIndex: 0,
  phase: "finished",
  heardSeconds: 5,
});
const cancelled = cancelReplay.cancelCall();
const dropped = cancelReplay.segment(cancelled.jumpTo);
await cancelReplay.reportProgress({
  segmentId: dropped.id,
  turnIndex: 0,
  phase: "finished",
  heardSeconds: 3,
});
await cancelReplay.archiveWrite;
const afterCancel = await store.load("listener_cancel_owner", cancelSaved.id);
assert.equal(afterCancel.playback.heardTurnKeys.length, 1, "handoff and dropped lines do not alter source progress");
assert.equal(afterCancel.playback.heardSeconds, 10);
const resumedTail = await cancelReplay.next({ timeoutMs: 0 });
assert.equal(resumedTail.segment.id, beforeCall.segment.id);
assert.equal(resumedTail.resumeFrom, 1, "cancel resumes at the first unheard original turn");
for (let index = 1; index < resumedTail.segment.turns.length; index += 1) {
  await cancelReplay.reportProgress({
    segmentId: resumedTail.segment.id,
    turnIndex: index,
    phase: "finished",
    heardSeconds: 1,
  });
}
const following = await cancelReplay.next({ timeoutMs: 0 });
assert.equal(following.segment.id, "seg_following", "the rest of the archived episode remains queued");
await new Promise((resolve) => setTimeout(resolve, 25));
globalThis.fetch = realFetch;
console.warn = realWarn;

assert.deepEqual(
  coveredTitlesFromPrefix([
    { kind: "topic", title: "Already heard", airedThrough: 0 },
    { kind: "topic", title: "Still ahead", airedThrough: -1 },
    { kind: "bridge", title: "Caller, you're on", airedThrough: 0 },
  ]),
  ["Already heard"],
  "a branch carries the subjects heard before the call into its new plan",
);

const healedAudio = new Segment({
  kind: "topic",
  archived: true,
  turns: [{ speaker: "ari", text: "Cached", audio: keys[0] }],
});
healedAudio.audioError = new Error("old transient failure");
await healedAudio.flushAudio({ findCached: async () => "/durable/audio.mp3" });
assert.equal(healedAudio.audioError, null, "a healed cache entry clears a transient render error");
const cancelledAudio = new Segment({ kind: "topic", cancelled: true, turns: [{ audio: "missing" }] });
await cancelledAudio.flushAudio({ findCached: async () => { throw new Error("cancelled audio was checked"); } });
const abandonedAudio = new Segment({ kind: "topic", abandoned: true, airedThrough: 0,
  turns: [{ audio: keys[0] }, { audio: "missing" }] });
await abandonedAudio.flushAudio({ findCached: async key => key === keys[0] ? "/original.mp3" : null });

const privacyRecord = structuredClone(sharedA.record);
privacyRecord.id = "ep_private_stats";
privacyRecord.state.heardDurations = { "seg_opening:0": 42 };
privacyRecord.state.segments.push({
  id: "seg_cancelled_private",
  kind: "topic",
  title: "Cancelled",
  turns: privacyRecord.state.segments[0].turns.slice(0, 2),
  cancelled: true,
  complete: true,
  airedThrough: -1,
});
privacyRecord.playback = {
  ...privacyRecord.playback,
  heardTurnKeys: ["seg_opening:0"],
  heardTurns: ["Welcome."],
  heardSeconds: 42,
};
const privateSaved = await store.save("listener_private_stats", privacyRecord);
assert.equal(store.metadata(privateSaved).turnCount, 3, "cancelled turns do not count as playable");
const privateShare = await store.share("listener_private_stats", privateSaved.id);
const publicStats = store.metadata(privateShare.record);
assert.equal(publicStats.heardTurnCount, 0);
assert.equal(publicStats.heardSeconds, 0, "the owner's listening progress is absent from a share");
assert.deepEqual(privateShare.record.state.heardDurations, {});

console.log("library engine tests passed");

await fs.rm(root, { recursive: true, force: true });
