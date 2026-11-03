import crypto from "node:crypto";
import { config } from "./config.js";
import { newsmcp, screenStories } from "./newsmcp.js";
import { majorSourceCount, outletName } from "./outlets.js";
import { phraseMatches, profiles } from "./profile.js";
import { claimPrimedResearch, dropPrimedResearch, primeResearch, researchForHosts } from "./research.js";
import {
  episodeOutlinePlan,
  firstEpisodeResearchSubject,
  nextEpisodeDefinition,
  showDefs,
  showScope,
} from "./showdef.js";
import { cachedPath, speak, voiceKey } from "./tts.js";
import { episodes } from "./episodes.js";
import {
  replanEpisode,
  deriveNextEpisode,
  scriptCallerCover,
  scriptCallerSegment,
  scriptOpening,
  scriptSegment,
} from "./llm.js";

const HOST = config.hosts;

/**
 * Stock lines, rendered once at boot and served from the disk cache. Each one
 * exists to cover a specific gap where there would otherwise be silence:
 *
 *   handoff — between the listener tapping the call button and the microphone
 *             opening. This is the invitation: the hosts have to actually hand
 *             over before it is the listener's turn to speak.
 *   hold    — between the listener finishing and the answer being researched.
 *   dropped — the listener hung up without saying anything.
 *
 * They are single turns on purpose. Two lines of banter here is two more seconds
 * before the caller can talk.
 */
const BRIDGES = {
  handoff: [
    [{ speaker: "ari", text: "Hold on — the board just lit up. Caller, you're on." }],
    [{ speaker: "dev", text: "We've got someone holding. Caller, go ahead — we're listening." }],
    [{ speaker: "ari", text: "Let me stop us there. Caller, you're on." }],
    [{ speaker: "dev", text: "Board's lit. Caller, go ahead." }],
  ],
  // Instant, generic, and short: it exists to fill the two seconds before the
  // hosts' own reaction to the question starts streaming, so it hands into that
  // rather than doing its job.
  hold: [
    [{ speaker: "ari", text: "Okay — hold on there." }],
    [{ speaker: "dev", text: "Right, I've got that." }],
    [{ speaker: "ari", text: "Okay. Let me take that one." }],
  ],
  dropped: [
    [{ speaker: "ari", text: "Looks like we lost them. Let's keep going." }],
    [{ speaker: "dev", text: "Caller's gone. Back to it." }],
  ],
  // A second cover line, for when the first round of research came back with
  // nothing and a retry is running underneath.
  stillLooking: [
    [{ speaker: "dev", text: "Bear with me — first pass didn't turn anything up. Trying again." }],
    [{ speaker: "ari", text: "Still digging on this one. Give me a moment." }],
  ],
  callReminder: [
    [{ speaker: "dev", text: "And remember, you can use Call in whenever you want to ask us something or steer where we go next." }],
    [{ speaker: "ari", text: "If you want us to explain something or take this another way, use Call in — we'll bring you straight into the show." }],
    [{ speaker: "dev", text: "You can call in at any point, by the way — with a question, a challenge, or a thread you want us to follow." }],
  ],
};

/**
 * What the hosts say when the research genuinely did not come back.
 *
 * Fixed text, rendered once, and never generated. The whole failure being fixed
 * here is a model asked to talk about a subject it was given nothing on — asking
 * that same model to say "we don't know" instead is not a fix, because saying it
 * convincingly and inventing the answer are the same capability. So the show
 * layer refuses to call the model at all, and reads these instead.
 */
const NO_RESEARCH = {
  topic: [
    { speaker: "ari", text: "We went looking for that one and nothing came back in time." },
    { speaker: "dev", text: "We're not going to talk around it, so let's move on and pick it up when we have sources." },
  ],
  caller: [
    { speaker: "dev", text: "I want to be straight with you — we went looking twice and the search didn't come back, so I have nothing solid on that." },
    { speaker: "ari", text: "We're not going to guess at it on air. Ask us again whenever you like and we'll have another go at it then." },
  ],
};

const newId = (prefix) => `${prefix}_${crypto.randomBytes(6).toString("hex")}`;

export const CALL_IN_REMINDER_FIRST_SECONDS = 5 * 60;
export const CALL_IN_REMINDER_REPEAT_SECONDS = 8 * 60;
const MAX_REPORTED_TURN_SECONDS = 10 * 60;

/** Count only one successfully finished playback report for a turn. */
export function countedHeardSeconds({ phase, heardSeconds, alreadyCounted = false } = {}) {
  if (phase !== "finished" || alreadyCounted) return 0;
  const seconds = Number(heardSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.min(seconds, MAX_REPORTED_TURN_SECONDS);
}

/** Pure scheduling rule; the Show applies it only at a natural segment boundary. */
export function callInReminderDue({
  heardSeconds = 0,
  lastReminderAtSeconds = null,
  hasCalled = false,
  atBoundary = false,
} = {}) {
  if (hasCalled || !atBoundary || !Number.isFinite(heardSeconds) || heardSeconds < 0) return false;
  if (lastReminderAtSeconds === null) return heardSeconds >= CALL_IN_REMINDER_FIRST_SECONDS;
  if (!Number.isFinite(lastReminderAtSeconds) || lastReminderAtSeconds < 0) return false;
  return heardSeconds - lastReminderAtSeconds >= CALL_IN_REMINDER_REPEAT_SECONDS;
}

export function coveredTitlesFromPrefix(segments = []) {
  return [...new Set(segments
    .filter((segment) => segment.airedThrough >= 0 && segment.kind !== "bridge" && segment.title)
    .map((segment) => segment.title))];
}

/** Stable identity for "we have already done this subject in this episode". */
export function topicKey(title) {
  const norm = String(title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!norm) return null;
  return "tk_" + crypto.createHash("sha1").update(norm).digest("hex").slice(0, 20);
}

function decorate(turn) {
  const host = HOST[turn.speaker] ?? HOST.ari;
  return {
    speaker: turn.speaker,
    name: host.name,
    text: turn.text,
    audio: voiceKey({ text: turn.text, voice: host.voice, instructions: host.delivery }),
    voice: host.voice,
    instructions: host.delivery,
    ttsModel: config.openai.ttsModel,
  };
}

function prerender(turn) {
  const host = HOST[turn.speaker] ?? HOST.ari;
  return speak({ text: turn.text, voice: host.voice, instructions: host.delivery });
}

export async function warmBridges() {
  await Promise.allSettled(
    [...Object.values(BRIDGES).flat(2), ...Object.values(NO_RESEARCH).flat()]
      .map((t) => {
        const host = HOST[t.speaker];
        return speak({ text: t.text, voice: host.voice, instructions: host.delivery });
      }),
  );
}

const pick = (list) => list[Math.floor(Math.random() * list.length)];

/**
 * Research, once, and then once more if the first round came back with nothing to
 * stand on. The retry is shorter than the first attempt: a search that has already
 * failed a full deadline is unlikely to want a second full one, and there is a
 * listener waiting either way.
 *
 * Returns whatever the better of the two rounds was. It may still be unusable, and
 * the caller is expected to check.
 */
async function researchWithRetry(args, { onRetry, headStart = null } = {}) {
  // A head start taken while the listener was still being asked the other setup
  // questions. Already finished, usually, and worth the same as a fresh round —
  // but only if it is about the thing being covered, which `claimPrimedResearch`
  // is what decides.
  if (headStart) {
    const ready = await claimPrimedResearch(headStart);
    if (ready) return ready;
  }
  const first = await researchForHosts(args);
  if (first.usable) return first;
  onRetry?.();
  const second = await researchForHosts({
    ...args,
    deadlineMs: Math.round((args.deadlineMs ?? config.timeouts.research) / 2),
  });
  return second.usable ? second : first;
}

export class Segment {
  constructor({
    id = null,
    kind,
    title = "",
    why = "",
    planItem = null,
    sources = [],
    coverKeys = [],
    bridgeRole = null,
    callerQuestion = null,
    researching = false,
    turns = [],
    complete = false,
    cancelled = false,
    aired = false,
    airedThrough = -1,
    abandoned = false,
    error = null,
    createdAt = Date.now(),
    archived = false,
    unresearched = false,
  }) {
    this.id = id || newId("seg");
    this.kind = kind; // opening | topic | bridge | caller | notice
    this.bridgeRole = bridgeRole;
    this.title = title;
    this.why = why;
    // Kept so a segment that gets dropped unheard can put its subject back on the
    // plan instead of being silently lost from the episode.
    this.planItem = planItem;
    this.sources = sources;
    this.callerQuestion = callerQuestion;
    // Subjects this segment genuinely works through. Only these are marked
    // covered, and only once the segment has actually been on air.
    this.coverKeys = coverKeys;
    // True while the research round is still running, so the client can say what
    // it is waiting for rather than showing an empty box.
    this.researching = researching;
    this.turns = turns.map((turn) => ({ ...turn }));
    this.complete = complete;
    this.cancelled = cancelled;
    this.aired = aired;
    // Highest turn index the client has confirmed playing. Delivery is idempotent
    // until this moves, so a reload resumes a segment instead of skipping it.
    this.airedThrough = airedThrough;
    // Set when a caller cuts this segment off, or the listener hurries it along:
    // it is neither finished nor resumable.
    this.abandoned = abandoned;
    this.error = error;
    this.createdAt = createdAt;
    this.archived = archived;
    this.unresearched = unresearched;
    this.onChange = null;
    this.pendingAudio = new Set();
    this.audioError = null;
    this.waiters = [];
  }

  addTurn(turn) {
    if (this.cancelled) return; // dropped: do not spend text-to-speech on it
    this.turns.push(decorate(turn));
    if (!this.archived) {
      const rendering = prerender(turn)
        .catch((err) => {
          this.audioError = err;
          console.warn(`[tts] ${err.message}`);
        })
        .finally(() => this.pendingAudio.delete(rendering));
      this.pendingAudio.add(rendering);
    }
    this.onChange?.();
    this.#wake();
  }

  setSources(sources) {
    this.sources = sources;
    this.researching = false;
    this.onChange?.();
    this.#wake();
  }

  finish(err = null) {
    this.complete = true;
    this.researching = false;
    this.error = err ? err.message : null;
    this.onChange?.();
    this.#wake();
  }

  cancel() {
    this.cancelled = true;
    this.complete = true;
    this.researching = false;
    this.onChange?.();
    this.#wake();
  }

  /** Cut short — keep what was heard, never offer the rest again. */
  abandon() {
    this.abandoned = true;
    this.onChange?.();
    this.#wake();
  }

  #wake() {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  /** Resolves once turn `index` exists, or the segment is finished without it. */
  waitForTurn(index, timeoutMs = 25000) {
    if (this.turns.length > index || this.complete) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(done, timeoutMs);
      const self = this;
      function done() {
        clearTimeout(timer);
        self.waiters = self.waiters.filter((w) => w !== done);
        resolve();
      }
      this.waiters.push(done);
    });
  }

  async flushAudio({ findCached = cachedPath } = {}) {
    if (this.cancelled) return;
    await Promise.all(this.pendingAudio);
    const missing = [];
    const turns = this.abandoned ? this.turns.slice(0, Math.max(0, this.airedThrough + 1)) : this.turns;
    for (const turn of turns) {
      if (!turn.audio || !(await findCached(turn.audio))) missing.push(turn.audio ?? "(missing key)");
    }
    if (missing.length) {
      const err = new Error(`Original audio is unavailable for ${missing.length} saved turn(s).`);
      err.code = "ARCHIVE_AUDIO_PENDING";
      throw err;
    }
    this.audioError = null;
  }

  view(from = 0) {
    return {
      id: this.id,
      kind: this.kind,
      bridgeRole: this.bridgeRole,
      title: this.title,
      why: this.why,
      callerQuestion: this.callerQuestion,
      sources: this.sources,
      researching: this.researching,
      from,
      turns: this.turns.slice(from),
      turnCount: this.turns.length,
      complete: this.complete,
      cancelled: this.cancelled,
      abandoned: this.abandoned,
      error: this.error,
    };
  }

  snapshot({ through = null } = {}) {
    const turns = through === null ? this.turns : this.turns.slice(0, Math.max(0, through + 1));
    return {
      id: this.id,
      kind: this.kind,
      bridgeRole: this.bridgeRole,
      title: this.title,
      why: this.why,
      planItem: this.planItem,
      sources: this.sources,
      callerQuestion: this.callerQuestion,
      coverKeys: this.coverKeys,
      researching: this.researching,
      turns,
      complete: this.complete,
      cancelled: this.cancelled,
      aired: this.aired,
      airedThrough: through === null ? this.airedThrough : Math.min(this.airedThrough, turns.length - 1),
      abandoned: this.abandoned,
      error: this.error,
      createdAt: this.createdAt,
      unresearched: !!this.unresearched,
    };
  }
}

export class Show {
  constructor(listenerId, { episodeStore = episodes } = {}) {
    this.listenerId = listenerId;
    this.episodeStore = episodeStore;
    this.def = null; // the show definition; nothing runs without one
    // Which podcast this is, for the profile. Interests learned here steer this
    // show and no other — see the note at the top of profile.js.
    this.scope = null;
    // Set when a podcast is defined: research was started during setup, and the
    // first subject of this episode may claim it. Carries the id that owns it, so
    // material gathered for a different description can never be read here.
    this.headStart = null;
    this.segments = [];
    this.deliveredThrough = -1; // index of the last segment handed to the client
    this.plan = []; // upcoming subjects: { title, query, why }
    this.covered = []; // titles aired this episode, for the re-planner
    this.seeds = []; // screened wire stories, news shows only
    this.seedsAt = 0;
    this.onAir = null; // { segmentId, turnIndex, text, title }
    this.building = null;
    this.planned = null; // resolves once the opening has produced a plan
    this.planGeneration = 0; // bumped whenever queued-but-unheard plans are voided
    this.episode = 0;
    this.started = false;
    this.starting = null; // in-flight start(), shared by every concurrent caller
    this.queueWaiters = [];
    this.call = null;
    // Where the caller pushed the episode. Steers the re-planner so the hour does
    // not snap back to the subject that was interrupted.
    this.direction = null;
    this.lastError = null;
    // Confirmed audio and committed script are separate continuity signals. The
    // former may be described as heard; the latter exists only to stop a lookahead
    // script duplicating a fact that is about to play.
    this.heardTurns = [];
    this.heardTurnKeys = new Set();
    // Reported media time, accumulated only once for each finished turn. Pauses
    // and buffering never enter this clock, so reminders follow listening rather
    // than wall time.
    this.heardSeconds = 0;
    this.heardDurations = new Map();
    this.lastCallReminderAtSeconds = null;
    this.hasCalled = false;
    this.nexting = null;
    this.archiveEpisodeId = null;
    this.parentEpisodeId = null;
    this.parentEpisodeTitle = null;
    this.readOnly = false;
    this.replay = false;
    this.shared = false;
    this.shareId = null;
    this.archiveWritable = true;
    this.archiveError = null;
    this.archiveWrite = Promise.resolve();
    this.lifecycleGeneration = 0;
    this.resetOnly = false;
    this.replayCallBackup = null;
    this.archiveContentIds = new Set();
  }

  /* ---------------- definition and lifecycle ---------------- */

  archiveSnapshot({ id = this.archiveEpisodeId, forkPrefix = false } = {}) {
    const sourceSegments = forkPrefix
      ? this.segments.filter((segment) => segment.airedThrough >= 0)
      : this.segments;
    const segments = sourceSegments.map((segment) => {
      if (typeof segment.snapshot === "function") {
        return segment.snapshot({ through: forkPrefix ? segment.airedThrough : null });
      }
      const saved = { ...segment, waiters: undefined, onChange: undefined };
      saved.turns = forkPrefix
        ? (segment.turns ?? []).slice(0, Math.max(0, segment.airedThrough + 1))
        : (segment.turns ?? []);
      return saved;
    });
    const keptIds = new Set(segments.map((segment) => segment.id));
    return structuredClone({
      id,
      seriesId: this.def?.seriesId,
      definition: this.def,
      parentEpisodeId: this.parentEpisodeId,
      parentEpisodeTitle: this.parentEpisodeTitle,
      isBranch: !!this.parentEpisodeId,
      state: {
        segments,
        plan: forkPrefix ? [] : this.plan,
        covered: this.covered,
        seeds: this.seeds,
        seedsAt: this.seedsAt,
        onAir: keptIds.has(this.onAir?.segmentId) ? this.onAir : null,
        deliveredThrough: forkPrefix ? segments.length - 1 : this.deliveredThrough,
        heardTurns: this.heardTurns,
        heardTurnKeys: [...this.heardTurnKeys].filter((key) => keptIds.has(key.split(":")[0])),
        heardDurations: Object.fromEntries(
          [...this.heardDurations].filter(([key]) => keptIds.has(key.split(":")[0])),
        ),
        heardSeconds: this.heardSeconds,
        direction: this.direction,
        lastCallReminderAtSeconds: this.lastCallReminderAtSeconds,
        hasCalled: this.hasCalled,
      },
    });
  }

  playbackSnapshot() {
    const allSegments = this.segments;
    const segments = allSegments.filter(
      (segment) => !this.replay || this.archiveContentIds.has(segment.id),
    );
    const segmentIds = new Set(segments.map((segment) => segment.id));
    const heardTurnKeys = [...this.heardTurnKeys].filter((key) => segmentIds.has(key.split(":")[0]));
    const heardTurns = [];
    for (const segment of segments) {
      for (let index = 0; index < segment.turns.length; index += 1) {
        if (heardTurnKeys.includes(`${segment.id}:${index}`)) heardTurns.push(segment.turns[index].text.slice(0, 240));
      }
    }
    const excludedSeconds = [...this.heardDurations]
      .filter(([key]) => !segmentIds.has(key.split(":")[0]))
      .reduce((total, [, seconds]) => total + seconds, 0);
    const deliveredThrough = segments.reduce(
      (highest, segment, index) => allSegments.indexOf(segment) <= this.deliveredThrough ? index : highest,
      -1,
    );
    return structuredClone({
      segments: segments.map((segment) => ({
        id: segment.id,
        aired: !!segment.aired,
        airedThrough: Number(segment.airedThrough ?? -1),
      })),
      deliveredThrough,
      onAir: segmentIds.has(this.onAir?.segmentId) ? this.onAir : null,
      covered: this.covered,
      heardTurns,
      heardTurnKeys,
      heardDurations: Object.fromEntries(
        [...this.heardDurations].filter(([key]) => segmentIds.has(key.split(":")[0])),
      ),
      heardSeconds: Math.max(0, this.heardSeconds - excludedSeconds),
      direction: this.direction,
      lastCallReminderAtSeconds: this.lastCallReminderAtSeconds,
      hasCalled: this.hasCalled,
    });
  }

  async archiveNow({ forceCreate = false } = {}) {
    if (!this.def || !this.archiveWritable) return null;
    if (!this.archiveEpisodeId && !forceCreate) return null;
    if (!this.archiveEpisodeId) this.archiveEpisodeId = `ep_${crypto.randomBytes(10).toString("hex")}`;
    const archiveEpisodeId = this.archiveEpisodeId;
    const replay = this.replay;
    const snapshot = replay ? this.playbackSnapshot() : this.archiveSnapshot();
    const write = this.archiveWrite.catch(() => {}).then(() =>
      replay
        ? this.episodeStore.savePlayback(this.listenerId, archiveEpisodeId, snapshot)
        : this.episodeStore.save(this.listenerId, snapshot),
    );
    this.archiveWrite = write;
    try {
      const saved = await write;
      if (this.archiveEpisodeId === archiveEpisodeId) this.archiveError = null;
      return saved;
    } catch (err) {
      if (this.archiveEpisodeId === archiveEpisodeId) this.archiveError = err.message;
      throw err;
    }
  }

  async flushArchive() {
    await Promise.all(this.segments.map((segment) => segment.flushAudio()));
    return this.archiveNow();
  }

  #archiveSoon() {
    if (!this.def || !this.archiveWritable || !this.archiveEpisodeId) return;
    const archiveEpisodeId = this.archiveEpisodeId;
    const replay = this.replay;
    const snapshot = replay ? this.playbackSnapshot() : this.archiveSnapshot();
    const write = this.archiveWrite.catch(() => {}).then(() =>
      replay
        ? this.episodeStore.savePlayback(this.listenerId, archiveEpisodeId, snapshot)
        : this.episodeStore.save(this.listenerId, snapshot),
    );
    this.archiveWrite = write;
    write.then(() => {
      if (this.archiveWrite === write && this.archiveEpisodeId === archiveEpisodeId) this.archiveError = null;
    }).catch((err) => {
      if (this.archiveEpisodeId === archiveEpisodeId) this.archiveError = err.message;
      console.error(`[archive] ${err.message}`);
    });
  }

  async archiveAndReset() {
    const lifecycle = ++this.lifecycleGeneration;
    await this.archiveNow();
    if (lifecycle !== this.lifecycleGeneration) return;
    this.reset();
  }

  async openArchive(record, { from = "start", shared = false, shareId = null } = {}) {
    if (!record?.definition || !Array.isArray(record?.state?.segments)) {
      const err = new Error("That saved episode is incomplete.");
      err.status = 422;
      err.code = "INVALID_EPISODE";
      throw err;
    }
    const lifecycle = ++this.lifecycleGeneration;
    await this.archiveNow();
    if (lifecycle !== this.lifecycleGeneration) {
      const err = new Error("A newer episode was opened first.");
      err.status = 409;
      err.code = "STALE_EPISODE_OPEN";
      throw err;
    }
    this.reset();
    this.def = structuredClone(record.definition);
    this.scope = showScope(this.def);
    this.archiveEpisodeId = record.id;
    this.parentEpisodeId = record.parentEpisodeId ?? null;
    this.parentEpisodeTitle = record.parentEpisodeTitle ?? null;
    this.readOnly = true;
    this.replay = true;
    this.shared = shared;
    this.shareId = shareId;
    this.archiveWritable = !shared;
    this.resetOnly = false;
    const resume = from === "resume" && !shared;
    const persistedPlayback = record.playback ?? record.state;
    const progressById = new Map(
      (persistedPlayback.segments ?? []).map((segment) => [segment.id, segment]),
    );
    this.segments = record.state.segments.map((saved) => {
      // An interrupted segment contains a generated tail the original listener
      // never heard. Replay only the confirmed prefix and seal that prefix as an
      // ordinary finished segment so it is offered from the beginning.
      const playable = saved.abandoned
        ? { ...saved, turns: (saved.turns ?? []).slice(0, Math.max(0, Number(saved.airedThrough) + 1)), abandoned: false }
        : saved;
      const progress = progressById.get(saved.id) ?? saved;
      const segment = new Segment({
        ...structuredClone(playable),
        archived: true,
        complete: true,
        researching: false,
        aired: resume ? !!progress.aired : false,
        airedThrough: resume ? Math.min(Number(progress.airedThrough ?? -1), playable.turns.length - 1) : -1,
      });
      segment.onChange = () => this.#archiveSoon();
      return segment;
    });
    this.archiveContentIds = new Set(this.segments.map((segment) => segment.id));
    this.plan = structuredClone(record.state.plan ?? []);
    this.covered = resume ? structuredClone(persistedPlayback.covered ?? []) : [];
    this.seeds = structuredClone(record.state.seeds ?? []);
    this.seedsAt = record.state.seedsAt ?? 0;
    const progressedThrough = this.segments.reduce(
      (highest, segment, index) => segment.airedThrough >= 0 ? index : highest,
      -1,
    );
    this.deliveredThrough = resume
      ? Math.max(Number(persistedPlayback.deliveredThrough ?? -1), progressedThrough)
      : -1;
    this.onAir = resume ? structuredClone(persistedPlayback.onAir ?? null) : null;
    this.heardTurns = resume ? structuredClone(persistedPlayback.heardTurns ?? []) : [];
    this.heardTurnKeys = new Set(resume ? persistedPlayback.heardTurnKeys ?? [] : []);
    this.heardDurations = new Map(
      resume ? Object.entries(persistedPlayback.heardDurations ?? {}) : [],
    );
    this.heardSeconds = resume ? Number(persistedPlayback.heardSeconds ?? 0) : 0;
    this.direction = resume ? structuredClone(persistedPlayback.direction ?? null) : null;
    this.lastCallReminderAtSeconds = resume ? persistedPlayback.lastCallReminderAtSeconds ?? null : null;
    this.hasCalled = resume ? !!persistedPlayback.hasCalled : false;
    this.started = true;
    return this.status();
  }

  async #forkReplay() {
    if (!this.replay) return null;
    const lifecycle = this.lifecycleGeneration;
    const generation = this.planGeneration;
    const call = this.call;
    const parentId = this.archiveEpisodeId;
    const parentTitle = this.def?.episodeTitle ?? null;
    const id = `ep_${crypto.randomBytes(10).toString("hex")}`;
    const snapshot = {
      ...this.archiveSnapshot({ id, forkPrefix: true }),
      parentEpisodeId: parentId,
      parentEpisodeTitle: parentTitle,
      isBranch: true,
      shareId: null,
    };
    snapshot.state.covered = coveredTitlesFromPrefix(snapshot.state.segments);
    const saved = await this.episodeStore.save(this.listenerId, snapshot);
    if (
      lifecycle !== this.lifecycleGeneration ||
      generation !== this.planGeneration ||
      this.call !== call ||
      call?.status !== "forking" ||
      !this.replay
    ) {
      try {
        await this.episodeStore.remove?.(this.listenerId, saved.id);
      } catch (cleanupError) {
        console.error(`[archive] stale fork cleanup failed: ${cleanupError.message}`);
      }
      const err = new Error("The episode changed while the call-in branch was being saved.");
      err.status = 409;
      err.code = "STALE_FORK";
      throw err;
    }
    this.segments = snapshot.state.segments.map((segment) => {
      const restored = new Segment({ ...structuredClone(segment), archived: true });
      restored.onChange = () => this.#archiveSoon();
      return restored;
    });
    this.deliveredThrough = this.segments.length - 1;
    this.onAir = snapshot.state.onAir;
    this.plan = [];
    this.archiveEpisodeId = saved.id;
    this.parentEpisodeId = parentId;
    this.parentEpisodeTitle = parentTitle;
    this.readOnly = false;
    this.replay = false;
    this.shared = false;
    this.shareId = null;
    this.archiveWritable = true;
    this.replayCallBackup = null;
    this.archiveContentIds.clear();
    return saved;
  }

  async define(definition, { researchId = null } = {}) {
    // Anything left over from the podcast being replaced belongs to nothing now.
    if (this.headStart?.researchId) dropPrimedResearch(this.headStart.researchId);
    // Invalidate a pending next-episode generation before its persistence boundary.
    // The definition becomes the live identity immediately; serialized disk writes
    // then ensure this later request is also the one that wins after a restart.
    const lifecycle = ++this.lifecycleGeneration;
    await this.archiveNow();
    if (lifecycle !== this.lifecycleGeneration) {
      dropPrimedResearch(researchId);
      const err = new Error("A newer podcast replaced this setup.");
      err.status = 409;
      err.code = "STALE_DEFINITION";
      throw err;
    }
    this.reset();
    const generation = this.planGeneration;
    this.def = definition;
    this.scope = showScope(this.def);
    this.resetOnly = false;
    await showDefs.save(this.listenerId, definition);
    if (generation !== this.planGeneration || this.def !== definition) {
      dropPrimedResearch(researchId);
      const err = new Error("A newer podcast replaced this setup while it was being saved.");
      err.status = 409;
      err.code = "STALE_DEFINITION";
      throw err;
    }
    this.headStart = researchId ? { researchId, generation: this.planGeneration } : null;
    await this.archiveNow({ forceCreate: true });
    return this.def;
  }

  async definition() {
    if (!this.def) {
      this.def = await showDefs.load(this.listenerId);
      this.scope = this.def ? showScope(this.def) : null;
    }
    return this.def;
  }

  /** Generate and persist another facet of this same series, then start it. */
  newEpisode({ derive = deriveNextEpisode, start = null } = {}) {
    if (this.nexting) return this.nexting;
    const lifecycle = ++this.lifecycleGeneration;
    const job = (async () => {
      const current = await this.definition();
      if (!current) {
        const err = new Error("This listener has not set up a podcast yet.");
        err.status = 409;
        err.code = "NO_SHOW";
        throw err;
      }
      await this.archiveNow();
      if (lifecycle !== this.lifecycleGeneration) {
        const err = new Error("The podcast changed while its next episode was being saved.");
        err.status = 409;
        err.code = "STALE_EPISODE";
        throw err;
      }
      const generation = this.planGeneration;
      const ownsEpisode = current.episodeId;
      const owns = () =>
        generation === this.planGeneration && this.def === current && this.def?.episodeId === ownsEpisode;
      const generated = await derive({ show: current });
      if (!owns()) {
        const err = new Error("The podcast changed while its next episode was being planned.");
        err.status = 409;
        err.code = "STALE_EPISODE";
        throw err;
      }
      const definition = nextEpisodeDefinition(current, generated);
      this.reset({ keepNexting: true });
      const episodeGeneration = this.planGeneration;
      this.def = definition;
      this.scope = showScope(this.def);
      this.resetOnly = false;
      await showDefs.save(this.listenerId, definition);
      if (this.planGeneration !== episodeGeneration || this.def !== definition) {
        const err = new Error("The podcast changed while its next episode was being saved.");
        err.status = 409;
        err.code = "STALE_EPISODE";
        throw err;
      }

      const researchId = `rid_${crypto.randomBytes(9).toString("hex")}`;
      const researchSubject = firstEpisodeResearchSubject(this.def);
      primeResearch({
        researchId,
        query: researchSubject,
        subject: researchSubject,
        show: this.def,
      });
      this.headStart = { researchId, generation: this.planGeneration };
      await this.archiveNow({ forceCreate: true });
      await (start ? start(this) : this.start());
      if (this.planGeneration !== episodeGeneration || this.def !== definition) {
        const err = new Error("The podcast changed while its next episode was starting.");
        err.status = 409;
        err.code = "STALE_EPISODE";
        throw err;
      }
      return this.def;
    })().finally(() => {
      if (this.nexting === job) this.nexting = null;
    });
    this.nexting = job;
    return job;
  }

  /**
   * Tear the episode down. Everything queued was written for a premise that no
   * longer applies, so it is voided rather than deferred — including a call that
   * was mid-flight, which is why the generation moves before anything else.
   */
  reset({ keepNexting = false } = {}) {
    this.planGeneration += 1;
    // Anything still in flight belongs to the episode being torn down. Its
    // generation check will make it return without touching this object, and
    // dropping the slots here means a fresh start is never blocked waiting on it.
    for (const segment of this.segments) {
      segment.onChange = null;
      segment.cancel();
    }
    if (this.headStart?.researchId) dropPrimedResearch(this.headStart.researchId);
    this.headStart = null;
    this.segments = [];
    this.deliveredThrough = -1;
    this.plan = [];
    this.covered = [];
    this.onAir = null;
    this.building = null;
    this.planned = null;
    this.started = false;
    this.starting = null;
    this.call = null;
    this.direction = null;
    this.heardTurns = [];
    this.heardTurnKeys.clear();
    this.heardSeconds = 0;
    this.heardDurations.clear();
    this.lastCallReminderAtSeconds = null;
    this.hasCalled = false;
    this.archiveEpisodeId = null;
    this.parentEpisodeId = null;
    this.parentEpisodeTitle = null;
    this.readOnly = false;
    this.replay = false;
    this.shared = false;
    this.shareId = null;
    this.archiveWritable = true;
    this.archiveError = null;
    this.archiveWrite = Promise.resolve();
    this.resetOnly = true;
    this.replayCallBackup = null;
    this.archiveContentIds.clear();
    if (!keepNexting) this.nexting = null;
    this.episode += 1;
    const waiters = this.queueWaiters;
    this.queueWaiters = [];
    for (const w of waiters) w();
  }

  #push(segment, { insertAfterDelivered = false } = {}) {
    segment.onChange = () => this.#archiveSoon();
    if (insertAfterDelivered) {
      this.segments.splice(this.deliveredThrough + 1, 0, segment);
    } else {
      this.segments.push(segment);
    }
    const waiters = this.queueWaiters;
    this.queueWaiters = [];
    for (const w of waiters) w();
    this.#archiveSoon();
    return segment;
  }

  segment(id) {
    return this.segments.find((s) => s.id === id) ?? null;
  }

  /**
   * Drop everything queued behind the segment that is actually on air. The cut is
   * made at `onAir`, not at the delivery cursor: the client prefetches one segment
   * ahead, so a subject can be delivered and still completely unheard. Those
   * segments were written for an episode that no longer exists, and nothing in
   * them was aired — so their subjects go back on the plan rather than vanishing.
   */
  #invalidateLookahead({ abandonOnAir = true, after = null } = {}) {
    this.planGeneration += 1;
    const airing = this.onAir ? this.segments.findIndex((s) => s.id === this.onAir.segmentId) : -1;
    let cut = airing >= 0 ? airing : this.deliveredThrough;
    // `after` is a segment that must survive whatever else is being thrown away.
    // The case this exists for: re-planning once a caller's answer is written, when
    // the line still on air is the hold bridge sitting *in front* of that answer —
    // cutting at the bridge would cancel the very answer that just came back.
    if (after) {
      const keepIndex = this.segments.findIndex((s) => s.id === after);
      if (keepIndex > cut) cut = keepIndex;
    }
    const keep = this.segments.slice(0, cut + 1);
    const returned = [];
    for (const segment of this.segments.slice(cut + 1)) {
      if (!segment.aired && segment.planItem) returned.push(segment.planItem);
      segment.cancel();
    }
    this.plan.unshift(...returned);
    // The segment the caller talked over keeps the turns already heard, but its
    // remaining turns belong to the episode that just ended.
    if (airing >= 0 && abandonOnAir) keep[airing].abandon();
    this.segments = keep;
    // Rewind the delivery cursor: anything the client was handed but never played
    // no longer exists, and the bridge goes straight after what it is hearing now.
    this.deliveredThrough = keep.length - 1;
  }

  /* ---------------- subject sourcing ---------------- */

  /**
   * Candidate subjects from the news wire, for shows that are actually about the
   * news. Screened before the planner ever sees them: a story no national outlet
   * carried, or that barely anyone ran, is not a story this show leads with. The
   * corroboration count does that screening and then stops — it never reaches the
   * script, because "forty newsrooms carried it" is not a fact about the world.
   */
  async #seedStories({ priority = "background" } = {}) {
    if (!this.def?.useWire) return [];
    const age = Date.now() - this.seedsAt;
    if (this.seeds.length && age < config.newsmcp.headlineTtlMs) return this.seeds;
    try {
      const result = await newsmcp.news(
        { sort: "trending", from_: "36 hours ago" },
        { priority, ttlMs: config.newsmcp.headlineTtlMs, cacheKey: "headlines:trending" },
      );
      if (result.events?.length) {
        this.seeds = screenStories(result.events);
        this.seedsAt = Date.now();
      }
      this.lastError = null;
    } catch (err) {
      this.lastError = err.message;
      console.warn(`[show] wire seeds unavailable: ${err.message}`);
    }
    return this.seeds;
  }

  /** Wire seeds this episode has not already used, best first. */
  async #freshSeeds(count = 8) {
    const stories = await this.#seedStories();
    if (!stories.length) return [];
    const profile = await profiles.load(this.listenerId);
    const used = new Set([...this.covered.map(topicKey), ...profile.covered]);
    const now = Date.now();
    return stories
      .filter((s) => !used.has(topicKey(s.headline)) && !used.has(s.key))
      .map((s) => {
        const hours = Math.max(0.5, (now - new Date(s.lastSeen || s.firstSeen || now).getTime()) / 3600000);
        const reach = Math.log10(1 + (s.newsrooms ?? 0)) * 2 + majorSourceCount(s) * 0.6;
        const recency = Math.max(0, 3 - Math.log2(hours));
        return {
          story: s,
          score: profiles.affinity(profile, s, { scope: this.scope }) * 1.2 + reach + recency,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, count)
      .map((x) => x.story);
  }

  /* ---------------- episode construction ---------------- */

  #recap() {
    const played = this.segments.filter((s) => s.aired && s.kind !== "bridge");
    const last = played[played.length - 1];
    if (!last) return "";
    if (last.kind === "caller") return `a listener asking about ${last.title}`;
    return last.title || last.turns.slice(-2).map((t) => t.text).join(" ");
  }

  /** What is on air right now, phrased so a caller's pronouns can be resolved. */
  context() {
    if (!this.onAir) return "";
    const parts = [];
    if (this.onAir.title) parts.push(`the subject on air is "${this.onAir.title}"`);
    if (this.onAir.text) parts.push(`the last line said was "${this.onAir.text}"`);
    return parts.join("; ");
  }

  /**
   * A bounded continuity budget for script prompts. Only `finished` progress enters
   * heard. Committed comes from the one delivered predecessor and is deliberately
   * labelled separately: it may be about to play, but was never claimed as heard.
   */
  memoryContext(beforeSegment = null, { heardLimit = 18, committedLimit = 10 } = {}) {
    const heard = this.heardTurns.slice(-Math.max(0, heardLimit));
    const before = beforeSegment ? this.segments.indexOf(beforeSegment) : this.segments.length;
    let predecessor = null;
    for (let i = Math.min(before - 1, this.deliveredThrough); i >= 0; i--) {
      const candidate = this.segments[i];
      if (!candidate || candidate.cancelled || candidate.abandoned || candidate.kind === "bridge") continue;
      predecessor = candidate;
      break;
    }
    const committed = predecessor
      ? predecessor.turns.slice(-Math.max(0, committedLimit)).map((turn) => turn.text.slice(0, 240))
      : [];
    return { heard, committed };
  }

  /**
   * Single-flight. `POST /show/start` kicks this off and the client's first
   * `GET /next` arrives immediately behind it; without sharing one promise both
   * would build an opening, and the second would queue a subject that races the
   * top of the episode onto the air.
   */
  start() {
    if (this.replay && this.started) return Promise.resolve();
    if (this.started) return Promise.resolve();
    if (!this.starting) {
      // Captured before the work begins and checked after every await. A reset can
      // land mid-start, and the old attempt must not then mark a torn-down episode
      // as started, nor clear the newer attempt's slot on its way out.
      const generation = this.planGeneration;
      const job = (async () => {
        const def = await this.definition();
        if (!def) {
          const err = new Error("This listener has not set up a podcast yet.");
          err.status = 409;
          err.code = "NO_SHOW";
          throw err;
        }
        if (this.resetOnly) {
          const err = new Error("This episode was reset. Choose a saved episode or set up a podcast.");
          err.status = 409;
          err.code = "EPISODE_RESET";
          throw err;
        }
        if (!this.archiveEpisodeId) {
          const archived = await this.episodeStore.findByDefinitionEpisodeId?.(
            this.listenerId,
            def.episodeId,
          );
          if (archived) {
            if (archived.state?.segments?.length) {
              await this.openArchive(archived, { from: "resume" });
              return;
            }
            this.archiveEpisodeId = archived.id;
          }
        }
        await this.archiveNow({ forceCreate: true });
        await this.#buildOpening();
        if (generation !== this.planGeneration) return;
        this.started = true;
      })().catch((err) => {
        // Let the next listener retry rather than wedging the show — but only if
        // this attempt still owns the slot.
        if (this.starting === job) this.starting = null;
        throw err;
      });
      this.starting = job;
    }
    return this.starting;
  }

  /**
   * The top of the episode. This deliberately runs before any research: the
   * welcome needs nothing but the premise the listener wrote, so they hear a voice
   * in a couple of seconds instead of waiting on a search. The saved outline is
   * already the plan, and research for its first beat is running underneath it.
   */
  async #buildOpening() {
    const generation = this.planGeneration;
    // Live headlines can be slower than the opening. Start them now, but do not
    // make Ari and Dev wait to introduce the episode; the news planner consumes
    // the screened result before it chooses a subject.
    const seedsReady = this.def.useWire ? this.#freshSeeds(8).catch(() => []) : Promise.resolve([]);
    const profile = await profiles.load(this.listenerId);
    if (generation !== this.planGeneration) return null;

    const segment = this.#push(
      new Segment({ kind: "opening", title: this.def.episodeTitle || this.def.title || "New episode" }),
    );

    // The description-time roadmap is the default running order. This makes the
    // promise heard in the opening enforceable rather than leaving it as display
    // copy that a later free-form planner may ignore.
    this.plan.push(...episodeOutlinePlan(this.def));

    this.planned = this.#run(segment, () =>
      scriptOpening({
        show: this.def,
        profileBrief: profiles.brief(profile, { scope: this.scope }),
        pacing: profile.pacing,
        onTurn: (t) => segment.addTurn(t),
      }),
    ).then(async () => {
      if (generation !== this.planGeneration) return this.plan;

      // Current-affairs shows still need the live editorial screen. It runs beside
      // the opening, then maps those screened stories onto the promised roadmap
      // before the first topic is researched. If the wire is unavailable, the
      // durable outline remains a usable fallback.
      const seeds = await seedsReady;
      if (generation !== this.planGeneration) return this.plan;
      if (this.def.useWire && seeds.length) {
        try {
          const livePlan = await replanEpisode({
            show: this.def,
            profileBrief: profiles.brief(profile, { scope: this.scope }),
            covered: this.covered,
            seeds,
            direction: null,
            planSize: Math.max(config.episode.planSize, this.def.episodeOutline?.length ?? 0),
          });
          if (generation === this.planGeneration && livePlan.length) this.plan = livePlan;
        } catch (err) {
          if (generation === this.planGeneration) {
            console.error(`[show] opening news plan failed: ${err.message}`);
            this.lastError = err.message;
          }
        }
      }
      return this.plan;
    });

    // Hand control back as soon as there is something to play, not when the whole
    // opening is written — the client is waiting on this to show the studio.
    await segment.waitForTurn(0, 25000);
    return segment;
  }

  async #replan() {
    const generation = this.planGeneration;
    const [profile, seeds] = await Promise.all([
      profiles.load(this.listenerId),
      this.#freshSeeds(8).catch(() => []),
    ]);
    if (generation !== this.planGeneration) return;
    try {
      const plan = await replanEpisode({
        show: this.def,
        profileBrief: profiles.brief(profile, { scope: this.scope }),
        covered: this.covered,
        seeds,
        direction: this.direction?.question ?? null,
        planSize: Math.max(config.episode.planSize, this.def.episodeOutline?.length ?? 0),
      });
      if (generation === this.planGeneration) this.plan.push(...plan);
    } catch (err) {
      console.error(`[show] re-plan failed: ${err.message}`);
      this.lastError = err.message;
    }
  }

  /**
   * The next subject: its own research round, then its own script. Every segment
   * gets a fresh search — nothing here re-reads a list pulled at the top of the
   * episode, which is what made the hosts sound like they were working from a
   * printout.
   */
  async buildNextSegment() {
    const generation = this.planGeneration;
    if (this.planned) await this.planned.catch(() => {});
    if (generation !== this.planGeneration) return null;
    if (!this.plan.length) await this.#replan();
    if (generation !== this.planGeneration) return null;

    const item = this.plan.shift();
    // The head start, spent here or never. Held as state rather than derived from
    // what has aired: the opening marks itself covered the moment it plays, so
    // counting made this false before the first subject was ever built. The
    // generation check retires it if the episode was torn down and rebuilt.
    const headStart =
      this.headStart && this.headStart.generation === this.planGeneration ? this.headStart : null;
    this.headStart = null;
    if (!item) {
      const seg = this.#push(new Segment({ kind: "notice", title: "Nothing more to run with" }));
      seg.addTurn({
        speaker: "dev",
        text: "That's everything we've got lined up. Call in and point us at something and we'll go from there.",
      });
      seg.finish();
      return seg;
    }

    const profile = await profiles.load(this.listenerId);
    const recap = this.#recap();
    const direction = this.direction;
    if (generation !== this.planGeneration) {
      this.plan.unshift(item);
      return null;
    }

    const segment = this.#push(
      new Segment({
        kind: "topic",
        title: item.title,
        why: item.why,
        planItem: item,
        coverKeys: [topicKey(item.title)].filter(Boolean),
        researching: true,
      }),
    );
    if (direction) direction.usedBy = (direction.usedBy ?? 0) + 1;
    const firstSubstantive = !this.segments.some((candidate) =>
      candidate !== segment && candidate.kind === "topic" && !candidate.cancelled
    );

    this.#run(segment, async () => {
      const research = await researchWithRetry(
        {
          query: item.query,
        // Wikipedia is a search over article titles, not a research instruction —
        // handed the full query it matches on an incidental word and comes back
        // with the wrong article entirely. The subject line is what it wants.
        subject: item.subject || item.title,
        context: recap,
          show: this.def,
          useWire: false, // the wire seeds the plan; segments are researched on the web
        },
        {
          // Only the first subject of an episode can use the head start, and only
          // once — claiming it consumes it, and it is refused outright unless it
          // is strongly about this subject and was gathered under the same rules.
          headStart: headStart
            ? {
                researchId: headStart.researchId,
                // Title and query together. A plan title is a screen label —
                // "Quarry and stone" — and matching against it alone threw away a
                // head start that was genuinely about the subject. The query names
                // the subject in full, because a search engine receives it with no
                // other context, which makes it the honest thing to compare.
                subject: item.subject || `${item.title} ${item.query}`,
                show: this.def,
              }
            : null,
        },
      );
      if (segment.cancelled) return null;
      segment.setSources(dedupeSources(research.sources));

      // The gate. Nothing came back that this show can stand a claim on, so the
      // model is not asked to write about the subject at all — it is handed
      // nothing and would fill the gap, which is exactly what went wrong on air.
      if (!research.usable) {
        console.warn(`[show] no usable research for "${item.title}" — skipping rather than inventing`);
        for (const line of NO_RESEARCH.topic) segment.addTurn(line);
        segment.unresearched = true;
        // The subject was never covered, so it is not marked as such and can come
        // back later when the search is working.
        segment.coverKeys = [];
        return null;
      }

      return scriptSegment({
        show: this.def,
        item,
        research,
        profileBrief: profiles.brief(profile, { scope: this.scope }),
        pacing: profile.pacing,
        recap,
          callerThread: direction && direction.usedBy <= 2 ? direction.question : null,
          memory: this.memoryContext(segment),
          firstSegment: firstSubstantive,
        onTurn: (t) => segment.addTurn(t),
      });
    });
    return segment;
  }

  async #run(segment, fn) {
    try {
      const result = await fn();
      if (segment.cancelled) return null;
      if (!segment.turns.length) {
        segment.addTurn({ speaker: "ari", text: "We lost the thread on that one. Let's move on." });
      }
      segment.finish();
      return result;
    } catch (err) {
      if (segment.cancelled) return null;
      console.error(`[show] segment ${segment.id} failed:`, err.message);
      if (!segment.turns.length) {
        segment.addTurn({
          speaker: "ari",
          text:
            err.code === "REFUSAL"
              ? "We're going to leave that one alone and pick up the next thing."
              : "We've got a technical problem at the desk. Give us a second and we'll pick it back up.",
        });
      }
      segment.finish(err);
      return null;
    }
  }

  /** True from the tap until the answer is written: the plan is about to change. */
  #callInFlight() {
    // `inviting` belongs here as much as the rest: the hosts have handed over and
    // the plan is one question away from being replaced. Leaving it out let a
    // segment be researched and scripted during the handoff and then again after
    // the re-plan — the same subject, twice, in one episode.
    return !!this.call && ["queued", "inviting", "live", "forking", "researching"].includes(this.call.status);
  }

  /**
   * Keep exactly one unplayed segment queued behind the one on air.
   *
   * Not private, along with `buildNextSegment` and `learnFromCall`: the races
   * around these three — a reset landing mid-build, a caller replacing the plan
   * while the hold line is still on air — are what the offline suite drives
   * directly, because reproducing them through the HTTP surface would mean timing
   * a live model call.
   */
  ensureLookahead() {
    if (this.replay) return;
    if (!this.started) return; // the opening is still being built
    // A caller is on the board. Anything built from the current plan is about to be
    // thrown away by the re-plan their question triggers, and building it now costs
    // a research round and a script for a segment nobody will ever hear.
    if (this.#callInFlight()) return;
    const undelivered = this.segments.length - 1 - this.deliveredThrough;
    if (undelivered > 0 || this.building) return;
    // Cleared unconditionally: a caller can void the plan while this build is in
    // flight, and a generation-guarded clear would leave `building` set forever and
    // wedge the lookahead. Only one build runs at a time (this guard is the reason),
    // and a stale one puts its subject back and returns null.
    // The slot is cleared only by the job that owns it. A reset (or a caller) can
    // start a new build while an old one is still in flight, and an unconditional
    // clear would let the old job's completion open the gate for a second
    // concurrent build of the same segment.
    const job = this.buildNextSegment().finally(() => {
      if (this.building === job) this.building = null;
    });
    this.building = job;
    job.catch((err) => console.error("[show] lookahead failed:", err.message));
  }

  /** Nothing more to play here: finished, dropped, or cut off. */
  #isSpent(segment) {
    if (!segment || segment.cancelled || segment.abandoned) return true;
    return segment.complete && segment.airedThrough >= segment.turns.length - 1;
  }

  /**
   * Hand the client whatever it should be playing. Resolves as soon as a turn is
   * available, not when the whole script is written.
   *
   * Delivery is idempotent until playback is acknowledged: handing a segment over
   * HTTP is not proof anyone heard it, so a client that reloads — or drops the
   * response — gets the same segment back, resuming after the last turn it
   * confirmed rather than skipping the segment entirely.
   */
  async next({ timeoutMs = 30000 } = {}) {
    await this.start();
    this.ensureLookahead();

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const current = this.segments[this.deliveredThrough];
      if (!this.#isSpent(current)) {
        const resumeFrom = current.airedThrough + 1;
        await current.waitForTurn(resumeFrom, Math.max(1000, deadline - Date.now()));
        if (!this.#isSpent(current)) return { segment: current, resumeFrom };
      }

      const idx = this.deliveredThrough + 1;
      const segment = this.segments[idx];
      if (segment && (this.#isSpent(segment) || (segment.complete && !segment.turns.length))) {
        this.deliveredThrough = idx;
        continue;
      }
      if (segment && !segment.cancelled) {
        await segment.waitForTurn(0, Math.max(1000, deadline - Date.now()));
        if (!segment.cancelled && segment.turns.length) {
          this.deliveredThrough = idx;
          this.ensureLookahead();
          return { segment, resumeFrom: segment.airedThrough + 1 };
        }
      }
      if (this.replay) return null;
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => {
        const timer = setTimeout(done, Math.min(2000, Math.max(200, deadline - Date.now())));
        const self = this;
        function done() {
          clearTimeout(timer);
          self.queueWaiters = self.queueWaiters.filter((w) => w !== done);
          resolve();
        }
        this.queueWaiters.push(done);
      });
    }
  }

  /**
   * The client reports what it is doing with a turn, in three phases.
   *
   *   started  — this line is on air now. It moves `onAir`, which is what a
   *              caller's pronouns resolve against, but it is not evidence that
   *              anybody heard it: the audio may still be blocked or broken.
   *   finished — the audio played to its end. Only this counts as heard, so it is
   *              what advances the resume point and marks a subject covered.
   *   skipped  — the audio permanently failed. It advances the resume point (or a
   *              broken line would re-offer itself forever) but earns no credit.
   *
   * Because the resume point only moves on a completed line, reconnecting during a
   * turn replays that turn rather than stepping over it.
   */
  reportProgress({ segmentId, turnIndex, phase = "finished", heardSeconds = 0 }) {
    const segment = this.segment(segmentId);
    if (!segment || segment.cancelled) return;
    if (!Number.isInteger(turnIndex) || turnIndex < 0) return;
    if (!segment.turns[turnIndex]) return;

    this.onAir = {
      segmentId,
      turnIndex,
      text: segment.turns[turnIndex]?.text ?? "",
      title: segment.title ?? null,
    };
    const idx = this.segments.indexOf(segment);
    if (idx > this.deliveredThrough) this.deliveredThrough = idx;

    if (phase !== "started") {
      segment.airedThrough = Math.max(segment.airedThrough, turnIndex);
      if (phase === "finished" && !segment.aired) {
        segment.aired = true;
        if (segment.title && segment.kind !== "bridge" && !this.covered.includes(segment.title)) {
          this.covered.push(segment.title);
        }
        if (!this.replay && segment.coverKeys.length) {
          profiles
            .markCovered(this.listenerId, segment.coverKeys)
            .catch((err) => console.warn(`[profile] markCovered: ${err.message}`));
        }
      }
      if (phase === "finished") {
        const key = `${segment.id}:${turnIndex}`;
        const text = segment.turns[turnIndex]?.text?.trim();
        const alreadyCounted = this.heardTurnKeys.has(key);
        if (!alreadyCounted) {
          this.heardTurnKeys.add(key);
          const counted = countedHeardSeconds({ phase, heardSeconds, alreadyCounted });
          this.heardDurations.set(key, counted);
          this.heardSeconds += counted;
          if (text) {
            this.heardTurns.push(text.slice(0, 240));
            if (this.heardTurns.length > 24) this.heardTurns.splice(0, this.heardTurns.length - 24);
          }
        }
      }
    }
    const atBoundary =
      phase !== "started" &&
      segment.complete &&
      turnIndex >= segment.turns.length - 1 &&
      this.segments.indexOf(segment) === this.deliveredThrough &&
      segment.kind !== "bridge";
    if (!this.replay && callInReminderDue({
      heardSeconds: this.heardSeconds,
      lastReminderAtSeconds: this.lastCallReminderAtSeconds,
      hasCalled: this.hasCalled,
      atBoundary,
    }) && !this.#callInFlight()) {
      const reminder = new Segment({
        kind: "bridge",
        bridgeRole: "call-reminder",
        title: "Call in anytime",
      });
      for (const line of pick(BRIDGES.callReminder)) reminder.addTurn(line);
      reminder.finish();
      this.#push(reminder, { insertAfterDelivered: true });
      this.lastCallReminderAtSeconds = this.heardSeconds;
    }
    this.ensureLookahead();
    this.#archiveSoon();
    return this.archiveWrite;
  }

  playbackComplete() {
    if (!this.replay) return false;
    const current = this.segments[this.deliveredThrough];
    if (!this.#isSpent(current)) return false;
    return !this.segments.slice(this.deliveredThrough + 1).some((segment) => !segment.cancelled);
  }

  /* ---------------- pacing controls ---------------- */

  /**
   * "Hurry up." Cuts this subject short after the line currently playing and
   * shortens everything after it. Deliberately does *not* touch what the listener
   * is interested in — the complaint is about length, and reading it as dislike is
   * how a profile ends up full of people who were merely named in a long segment.
   */
  async hurry(segmentId) {
    if (this.replay) {
      const err = new Error("Call in to make your own version before changing a saved episode.");
      err.status = 409;
      err.code = "READ_ONLY_REPLAY";
      throw err;
    }
    const segment = this.segment(segmentId) ?? this.segments[this.deliveredThrough];
    if (!segment) return null;
    segment.abandon();
    const profile = await profiles.recordPace(this.listenerId, {
      action: "hurry",
      title: segment.title,
      scope: this.scope,
    });
    this.ensureLookahead();
    return { pacing: profile.pacing, title: segment.title };
  }

  /**
   * "Dive deeper." Puts a second, deeper pass at this same subject next in the
   * plan — with its own research round — and tells the hosts to take longer from
   * here on. Anything already queued behind the current segment is voided so the
   * deeper pass is genuinely what comes next.
   */
  async deeper(segmentId) {
    if (this.replay) {
      const err = new Error("Call in to make your own version before changing a saved episode.");
      err.status = 409;
      err.code = "READ_ONLY_REPLAY";
      throw err;
    }
    const segment = this.segment(segmentId) ?? this.segments[this.deliveredThrough];
    if (!segment || segment.kind === "bridge") return null;

    const subject = segment.title;
    this.#invalidateLookahead({ abandonOnAir: false });
    this.plan.unshift({
      title: `${subject} — further in`,
      query:
        `${subject}. Go deeper than a summary: the mechanism or the sequence of events, ` +
        `the numbers, the history behind it, and who disagrees about it and why.`,
      why: "the listener asked the hosts to go further into this",
    });
    const profile = await profiles.recordPace(this.listenerId, {
      action: "deeper",
      title: subject,
      topics: [segment.callerQuestion ? conciseSubject(segment.callerQuestion) || subject : subject],
      scope: this.scope,
    });
    this.ensureLookahead();
    return { pacing: profile.pacing, title: subject };
  }

  /* ---------------- call-in ---------------- */

  /**
   * The listener tapped the call button. The board lights up, the hosts finish the
   * line they are on, and then a handoff bridge invites the caller in — the
   * microphone does not open until that invitation has actually played.
   */
  /**
   * The tap. This lights the board and nothing else: the hosts keep talking while
   * the browser's microphone permission is still on screen, and no segment is
   * disturbed yet. The invitation is a separate step so it can never air before
   * there is a recorder ready to catch the first syllable of the answer.
   */
  queueCall() {
    if (["forking", "researching"].includes(this.call?.status)) {
      const err = new Error("The hosts are still working on your last question.");
      err.code = "CALL_IN_PROGRESS";
      err.status = 409;
      throw err;
    }
    if (this.call && ["queued", "inviting", "live"].includes(this.call.status)) {
      return { call: this.call, jumpTo: this.call.bridgeId, resumed: true };
    }
    this.hasCalled = true;
    // A reminder waiting behind the current line has already done its scheduling
    // job, but a real call now makes it obsolete. Leave anything currently on air
    // alone and quietly remove only undelivered reminders.
    for (let index = this.segments.length - 1; index > this.deliveredThrough; index--) {
      const segment = this.segments[index];
      if (segment?.bridgeRole !== "call-reminder") continue;
      segment.cancel();
      this.segments.splice(index, 1);
    }
    this.call = {
      id: newId("call"),
      status: "queued",
      question: null,
      segmentId: null,
      bridgeId: null,
      startedAt: Date.now(),
      // Snapshot what was on air at the moment of the tap. By the time they finish
      // speaking, `onAir` is the handoff line the hosts read out — resolving "what
      // about them?" against "Caller, you're on" answers the wrong question.
      context: this.context(),
      recap: this.onAir?.title || this.#recap(),
    };
    // Handoff changes remain local until the listener submits a real question.
    // Progress through the last host line and the invitation can then be included
    // in the fork, while a cancelled microphone prompt creates no empty branch.
    if (this.replay) {
      this.replayCallBackup = this.archiveSnapshot();
      this.archiveWritable = false;
    }
    return { call: this.call, jumpTo: null, resumed: false };
  }

  /**
   * The recorder is prepared. Now the hosts hand over: the segment on air is cut
   * after the line it is on, and the invitation goes straight behind it.
   */
  inviteCaller() {
    const call = this.call;
    if (!call || !["queued", "inviting"].includes(call.status)) return null;
    if (call.bridgeId) return { call, jumpTo: call.bridgeId };

    this.#invalidateLookahead();
    const bridge = new Segment({ kind: "bridge", bridgeRole: "handoff", title: "Caller, you're on" });
    for (const line of pick(BRIDGES.handoff)) bridge.addTurn(line);
    bridge.finish();
    this.#push(bridge, { insertAfterDelivered: true });
    call.bridgeId = bridge.id;
    call.status = "inviting";
    return { call, jumpTo: bridge.id };
  }

  /** The invitation has played and the recorder is running. */
  markCallLive() {
    if (this.call && ["queued", "inviting"].includes(this.call.status)) this.call.status = "live";
    return this.call;
  }

  /**
   * The listener hung up, denied the microphone, or nothing came through. The
   * hosts say so and the episode carries on; nothing is left half-queued.
   */
  cancelCall({ reason = "hung up" } = {}) {
    const call = this.call;
    if (!call || ["answered", "cancelled"].includes(call.status)) return null;
    call.status = "cancelled";
    call.reason = reason;

    if (this.replay && this.replayCallBackup) {
      const bridgeAired = !!this.segment(call.bridgeId)?.aired;
      const progress = new Map(this.segments.map((segment) => [segment.id, segment]));
      const backup = this.replayCallBackup;
      this.segments = backup.state.segments.map((saved) => {
        const latest = progress.get(saved.id);
        const segment = new Segment({
          ...structuredClone(saved),
          archived: true,
          complete: true,
          researching: false,
          aired: latest ? !!latest.aired : !!saved.aired,
          airedThrough: latest
            ? Math.max(Number(saved.airedThrough ?? -1), Number(latest.airedThrough ?? -1))
            : Number(saved.airedThrough ?? -1),
        });
        segment.onChange = () => this.#archiveSoon();
        return segment;
      });
      this.archiveContentIds = new Set(this.segments.map((segment) => segment.id));
      this.deliveredThrough = this.segments.reduce(
        (highest, segment, index) => segment.airedThrough >= 0 ? index : highest,
        -1,
      );
      const last = this.segments[this.deliveredThrough];
      this.onAir = last
        ? {
            segmentId: last.id,
            turnIndex: last.airedThrough,
            text: last.turns[last.airedThrough]?.text ?? "",
            title: last.title ?? null,
          }
        : null;
      this.covered = coveredTitlesFromPrefix(this.segments);
      this.replayCallBackup = null;
      this.archiveWritable = !this.shared;
      this.#archiveSoon();
      if (bridgeAired) {
        const notice = new Segment({ kind: "bridge", bridgeRole: "dropped", title: "Caller dropped" });
        for (const line of pick(BRIDGES.dropped)) notice.addTurn(line);
        notice.finish();
        // The client plays this by jumpTo. Insert it immediately before the
        // restored source segment so completing the notice leads back to the
        // first unheard original turn instead of stepping over that tail.
        this.deliveredThrough = Math.max(-1, this.deliveredThrough - 1);
        this.#push(notice, { insertAfterDelivered: true });
        return { call, jumpTo: notice.id };
      }
      return { call, jumpTo: null };
    }

    // Everything this call put in the queue goes now, before any branch returns.
    // The failure otherwise: the invitation had aired, so the "we lost them" branch
    // returned early, and the hold line — "give me a second, I'm pulling that up" —
    // was still queued behind it for a caller who had already hung up.
    for (const id of [call.coverId, call.segmentId]) {
      const segment = id ? this.segment(id) : null;
      if (!segment) continue;
      if (segment.aired) segment.abandon();
      else segment.cancel();
    }
    const hold = call.holdId ? this.segment(call.holdId) : null;
    if (hold && !hold.aired) hold.cancel();

    const bridge = this.segment(call.bridgeId);
    // Only worth explaining if the hosts already invited them in out loud.
    if (bridge?.aired) {
      const notice = new Segment({ kind: "bridge", bridgeRole: "dropped", title: "Caller dropped" });
      for (const line of pick(BRIDGES.dropped)) notice.addTurn(line);
      notice.finish();
      this.#push(notice, { insertAfterDelivered: true });
      this.ensureLookahead();
      return { call, jumpTo: notice.id };
    }

    // The invitation never aired: drop it silently rather than saying "we lost
    // them" about a caller the listener never heard announced.
    if (bridge && !bridge.aired) bridge.cancel();
    this.ensureLookahead();
    return { call, jumpTo: null };
  }

  /**
   * The listener has finished speaking. A pre-rendered hold line goes in front of
   * the answer so there is something on air immediately, everything queued behind
   * the current segment is voided, and the research — a fresh search, run for this
   * question, every time — happens while that line plays.
   */
  async submitCall({ question }) {
    const call = this.call ?? this.queueCall().call;
    // One submit per call. Without this a double tap (or the keyboard shortcut
    // racing the disabled button) generates a second answer for the same question,
    // and both fight over the air.
    if (!["queued", "inviting", "live"].includes(call.status)) {
      const err = new Error(
        ["forking", "researching"].includes(call.status)
          ? "That question is already with the hosts."
          : "That call has already been answered — start a new one.",
      );
      err.code = "CALL_ALREADY_SUBMITTED";
      err.status = 409;
      throw err;
    }
    const priorStatus = call.status;
    call.question = question;
    // Claim the submission before the durable fork await. A second request now
    // sees an in-flight call and cannot create another branch from the same tap.
    call.status = "forking";
    const forked = this.replay;
    try {
      if (this.replay) await this.#forkReplay();
    } catch (err) {
      if (this.call === call && call.status === "forking") {
        call.status = priorStatus;
        call.question = null;
      }
      throw err;
    }
    call.status = "researching";

    // Taken when the board lit up, not now: see queueCall.
    const context = call.context || this.context();
    const recap = call.recap || this.#recap();

    this.#invalidateLookahead();

    const bridge = new Segment({ kind: "bridge", bridgeRole: "hold", title: "Looking that up" });
    for (const line of pick(BRIDGES.hold)) bridge.addTurn(line);
    bridge.finish();
    this.#push(bridge, { insertAfterDelivered: true });
    call.holdId = bridge.id;

    // Two segments, not one. The cover is what the hosts say while the search runs
    // — the question read back, the reaction, the connection to what was on air —
    // and it starts streaming in a couple of seconds because it needs no research.
    // The answer follows it, and only exists if the research came back.
    const cover = new Segment({
      kind: "caller",
      title: question.slice(0, 120),
      callerQuestion: question,
    });
    const answer = new Segment({
      kind: "caller",
      title: question.slice(0, 120),
      researching: true,
    });
    cover.onChange = () => this.#archiveSoon();
    answer.onChange = () => this.#archiveSoon();
    this.segments.splice(this.segments.indexOf(bridge) + 1, 0, cover, answer);
    this.#archiveSoon();
    call.coverId = cover.id;
    call.segmentId = answer.id;

    const generation = this.planGeneration;
    // Snapshotted with the generation, and used everywhere below instead of the
    // live fields. The answer takes tens of seconds to research and write, and a
    // listener who redefines their podcast in that window would otherwise have
    // this call filed against the new show — labelling a question they asked about
    // football as an interest of their podcast about history.
    const scope = this.scope;
    const def = this.def;
    const profile = await profiles.load(this.listenerId);
    // `recordCallIn` mutates this cached profile object in place. Snapshot what the
    // hosts knew before this call so the question they are answering cannot be
    // presented back to its caller as something they asked on a previous call.
    const brief = profiles.brief(profile, { scope });
    const knownFor = [
      ...profiles.interests(profile, { include: "current", scope, limit: 6 }).entities,
      ...profiles.interests(profile, { include: "current", scope, limit: 6 }).topics,
    ]
      .filter((r) => r.score > 0)
      .map((r) => r.label);

    // Log the call before anything can fail: what they asked is the signal, and it
    // must survive a failed search or a refused script. The caller-context snapshot
    // above deliberately precedes this mutation; both script and research follow it.
    await profiles
      .recordCallIn(this.listenerId, { text: question, scope })
      .catch((err) => console.error(`[call] could not log call-in: ${err.message}`));

    // The cover and the research start together and neither waits on the other.
    // This is the whole latency story of a call-in: by the time the hosts have
    // finished reacting to the question, the answer to it has arrived.
    const covering = this.#run(cover, () =>
      scriptCallerCover({
        show: def,
        question,
        profileBrief: brief,
        knownFor,
        recap,
        onTurn: (t) => cover.addTurn(t),
      }),
    );

    // Kick off, do not await: the client is already playing the hold line.
    (async () => {
      if (cover.cancelled) return;
      const research = await researchWithRetry(
        {
          query: question,
          subject: conciseSubject(question),
          context,
          show: def,
          // The wire is worth a metered call here and nowhere else: a listener
          // asking "what else is going on" wants a fresh headline list, not a
          // re-read of the one this episode was planned from.
          useWire: !!def?.useWire,
        },
        {
          // Something has to be on air while the second attempt runs, and the
          // cover may already have finished playing.
          onRetry: () => {
            if (!answer.cancelled) for (const line of pick(BRIDGES.stillLooking)) answer.addTurn(line);
          },
        },
      );
      if (answer.cancelled) return;
      answer.setSources(dedupeSources(research.sources));

      // The gate, on the path where inventing an answer does the most damage: the
      // listener asked a direct question and is waiting for a direct reply.
      if (!research.usable) {
        console.warn(`[call] no usable research for "${question.slice(0, 60)}" — refusing to invent`);
        for (const line of NO_RESEARCH.caller) answer.addTurn(line);
        answer.unresearched = true;
        answer.finish();
        call.status = "unanswerable";
        // What they asked still counts, even though the search failed them.
        await covering
          .then((c) => this.learnFromCall(c, question, generation, { scope, call }))
          .catch(() => {});
        this.ensureLookahead();
        return;
      }

      const result = await this.#run(answer, () =>
        scriptCallerSegment({
          show: def,
          question,
          research,
          profileBrief: brief,
          pacing: profile.pacing,
          recap,
          memory: this.memoryContext(answer),
          planSize: config.episode.planSize - 1,
          onTurn: (t) => answer.addTurn(t),
        }),
      );
      // A hang-up, or a new premise, while this was running. Neither the status nor
      // the profile nor the plan belongs to this call any more.
      if (answer.cancelled || call.status === "cancelled" || generation !== this.planGeneration) {
        if (call.status !== "cancelled") call.status = "dropped";
        this.ensureLookahead();
        return;
      }
      call.error = answer.error ?? null;

      // Still "researching" while this runs: the status is what holds the lookahead
      // shut, and releasing it before the replacement plan is installed would let
      // the next segment be built from the plan the caller just replaced.
      //
      // What the caller cares about is read off the cover, not the answer — it is a
      // fact about the question, and it must not depend on whether the search worked.
      const covered = await covering.catch(() => null);
      await this.learnFromCall({ ...covered, plan: result?.plan }, question, generation, { scope, call });
      if (call.status === "researching") call.status = answer.error ? "failed" : "answered";
      this.ensureLookahead();
    })().catch((err) => {
      // Terminal catch for the detached task. Nothing above it can surface a
      // rejection, and an unhandled one would take the process down.
      console.error("[call] answering failed:", err.stack || err.message);
      if (call.status === "researching") call.status = "failed";
      call.error = err.message;
      if (!answer.complete) answer.finish(err);
      this.ensureLookahead(); // the gate is released, so the episode can continue
    });

    await this.archiveNow();
    return {
      call,
      jumpTo: bridge.id,
      coverSegmentId: cover.id,
      answerSegmentId: answer.id,
      episodeId: this.archiveEpisodeId,
      forked,
    };
  }

  /**
   * Everything the profile learns from a call-in, and nothing else.
   *
   * The lists used here are the model's read of what the *caller* asked about, not
   * of what the hosts said back. That distinction is the fix for names appearing
   * in a listener's profile because a generated answer happened to mention them.
   */
  async learnFromCall(result, question, generation, { scope = this.scope, call = this.call } = {}) {
    // Ownership, checked before the first write and again before the last: the
    // podcast can be redefined at any point during the awaits below, and every
    // mutation here belongs to the call that started them.
    const owns = () =>
      generation === this.planGeneration && this.call === call && call?.status !== "cancelled";
    if (!owns()) return;
    const preferences = result?.preferences ?? [];
    for (const pref of preferences) {
      if (!owns()) return;
      await profiles
        .setPreference(this.listenerId, pref.label, pref.direction, { scope })
        .catch((err) => console.warn(`[profile] preference: ${err.message}`));
    }

    // Anything they asked to hear less of is dropped from both lists. Learning
    // "Elon Musk" as an entity because they said "less Elon Musk" would steer the
    // rest of the episode straight back at it.
    const rejected = preferences.filter((p) => p.direction === "less").map((p) => p.label);
    // Whole phrases only. A bare substring test makes "less AI" reject Thailand,
    // and "less rail" reject Israel — quietly deleting subjects the listener never
    // said anything about.
    const isRejected = (value) => {
      const normalized = normalizeForCompare(value);
      if (!normalized) return true;
      return rejected.some((label) => {
        const l = normalizeForCompare(label);
        if (!l) return false;
        return l === normalized || phraseMatches(l, normalized) || phraseMatches(normalized, l);
      });
    };
    const topics = (result?.interests?.topics ?? []).filter((t) => !isRejected(t));
    // A name only enters the profile if the listener actually said it. The prompt
    // asks for this too, but a prompt is a request and this is the guarantee: it is
    // the check that stops a stranger being pinned to someone's profile because a
    // generated answer happened to mention them.
    const entities = (result?.interests?.entities ?? [])
      .filter((e) => !isRejected(e))
      .filter((e) => saidByCaller(e, question));

    if ((topics.length || entities.length) && owns()) {
      await profiles
        .applyInterests(this.listenerId, {
          labels: topics,
          entities,
          source: "caller",
          scope,
        })
        .catch((err) => console.warn(`[profile] interests: ${err.message}`));
    }

    if (!owns()) return;
    this.direction = { question, topics, entities, usedBy: 0, at: Date.now() };
    // The rest of the episode, re-planned around where the listener just took it.
    //
    // Nothing is cut here, and that is deliberate. The queue was already emptied
    // when the question was submitted, and `#callInFlight` has held the lookahead
    // shut ever since — so there is nothing stale left to drop. Re-cutting at this
    // point would be actively wrong: if playback is slow or paused, the line still
    // on air is the hold bridge sitting in *front* of the answer, and a cut there
    // cancels the answer that has just been written.
    if (result?.plan?.length) this.plan = [...result.plan];
  }

  status() {
    return {
      listenerId: this.listenerId,
      show: this.def
        ? {
            title: this.def.title,
            presetId: this.def.presetId,
            about: this.def.about,
            useWire: this.def.useWire,
            families: this.def.families,
            scope: this.scope,
            seriesId: this.def.seriesId,
            episodeId: this.archiveEpisodeId,
            readOnly: this.readOnly,
            replay: this.replay,
            shared: this.shared,
            parentEpisodeId: this.parentEpisodeId,
            shareId: this.shareId,
            playbackComplete: this.playbackComplete(),
          }
        : null,
      started: this.started,
      episode: this.episode,
      segments: this.segments.length,
      deliveredThrough: this.deliveredThrough,
      planGeneration: this.planGeneration,
      planned: this.plan.map((p) => p.title),
      covered: this.covered,
      onAir: this.onAir,
      call: this.call,
      direction: this.direction ? { question: this.direction.question, usedBy: this.direction.usedBy } : null,
      seeds: this.seeds.length,
      heardSeconds: this.heardSeconds,
      lastCallReminderAtSeconds: this.lastCallReminderAtSeconds,
      hasCalled: this.hasCalled,
      lastError: this.lastError,
      archiveError: this.archiveError,
      newsmcp: newsmcp.status(),
    };
  }
}

const normalizeForCompare = (v) =>
  String(v ?? "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * The thing a spoken question is *about*, short enough to search an encyclopaedia
 * with.
 *
 * A real call is not a query. "Start with this: how did Roman aqueducts move water
 * uphill? I'd like more engineering explanations" handed to Wikipedia whole comes
 * back with an article about Glasgow, because the long tail of ordinary words
 * outweighs the two that matter. This keeps the first question, drops the framing
 * around it, and caps the length.
 */
export function conciseSubject(question) {
  let text = String(question ?? "").trim();
  // The first question mark is almost always the end of the actual ask; anything
  // after it is the listener adding what they want more of in general.
  const q = text.indexOf("?");
  if (q > 12) text = text.slice(0, q);
  // Drop a lead-in clause: "start with this:", "quick one —", "hey guys,".
  text = text.replace(/^[^:\u2014-]{0,40}[:\u2014-]\s+/, "");
  text = text.replace(
    /^(hey|hi|hello|ok|okay|so|right|um|erm)\b[\s,]*(guys|team|there|folks)?[\s,]*/i,
    "",
  );
  // Interrogative scaffolding carries no subject. "can you talk about X" and
  // "how did X work" both need it gone before what is left names anything.
  text = text.replace(
    /^(what|who|when|where|why|how|can|could|would|will|is|are|was|were|do|does|did|tell|talk|say)\b[\s\w']{0,24}?\b(about|with|on|for|to)\b\s+/i,
    "",
  );
  text = text.replace(
    /^(what|who|when|where|why|how|which)\b\s+(is|are|was|were|do|does|did|has|have|had|can|could|would|will)\b\s+/i,
    "",
  );
  text = text.replace(/^(the|a|an)\s+/i, "");

  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  // Six words is about as much as a title search can take before the ordinary
  // ones outweigh the ones that name the subject.
  return words.slice(0, 6).join(" ") || String(question ?? "").slice(0, 80);
}

/**
 * Did the caller actually name this? Whole words only, and a multi-word name
 * counts if the distinctive part of it was said — transcription gives "Musk"
 * where the model returns "Elon Musk", and refusing that would learn nothing at
 * all from a real call.
 */
export function saidByCaller(name, question) {
  const said = ` ${normalizeForCompare(question)} `;
  const wanted = normalizeForCompare(name);
  if (!wanted || said.trim().length === 0) return false;
  if (said.includes(` ${wanted} `)) return true;
  const parts = wanted.split(" ").filter((w) => w.length > 2);
  if (!parts.length) return false;
  // Every distinctive word has to appear, so "Elon Musk" is not learned from a
  // question that merely said "Elon Gonzalez".
  return parts.every((w) => said.includes(` ${w} `));
}

function dedupeSources(sources) {
  const seen = new Set();
  const out = [];
  for (const s of sources) {
    if (!s?.url || seen.has(s.url)) continue;
    seen.add(s.url);
    out.push({ ...s, name: s.name ?? outletName(s.url) ?? s.host });
  }
  return out.slice(0, 10);
}

export const MAX_RESIDENT_SHOWS = 256;
export const SHOW_IDLE_TTL_MS = 60 * 60 * 1000;

/** Work that must never be torn down merely to admit a fabricated listener id. */
export function showIsActive(show) {
  if (!show) return false;
  if (show.building || show.nexting || (!show.started && show.starting)) return true;
  if (show.queueWaiters?.length) return true;
  if (show.segments?.some((segment) => !segment.cancelled && !segment.complete)) return true;
  return !!show.call && ["queued", "inviting", "live", "researching"].includes(show.call.status);
}

/**
 * A bounded, touch-on-access registry for per-listener episode state. Only a show
 * that has gone untouched for an hour and has no work in flight may be evicted.
 * At capacity, active and recently used listeners keep their place and admission
 * fails explicitly rather than growing the process without limit.
 */
export class ShowRegistry {
  constructor({
    max = MAX_RESIDENT_SHOWS,
    idleMs = SHOW_IDLE_TTL_MS,
    now = () => Date.now(),
    create = (listenerId) => new Show(listenerId),
    isActive = showIsActive,
  } = {}) {
    const parsedMax = Number(max);
    const parsedIdleMs = Number(idleMs);
    this.max = Number.isFinite(parsedMax) ? Math.max(1, Math.floor(parsedMax)) : MAX_RESIDENT_SHOWS;
    this.idleMs = Number.isFinite(parsedIdleMs) ? Math.max(0, parsedIdleMs) : SHOW_IDLE_TTL_MS;
    this.now = now;
    this.create = create;
    this.isActive = isActive;
    this.entries = new Map();
  }

  get(listenerId) {
    const at = this.now();
    const current = this.entries.get(listenerId);
    if (current) {
      current.lastAccess = at;
      return current.show;
    }

    this.evictIdle(at);
    if (this.entries.size >= this.max) {
      const err = new Error("The studio is at listener capacity. Try again shortly.");
      err.status = 503;
      err.code = "SHOW_CAPACITY";
      throw err;
    }
    const show = this.create(listenerId);
    this.entries.set(listenerId, { show, lastAccess: at });
    return show;
  }

  evictIdle(at = this.now()) {
    const eligible = [...this.entries.entries()]
      .filter(([, entry]) => at - entry.lastAccess >= this.idleMs && !this.isActive(entry.show))
      .sort((a, b) => a[1].lastAccess - b[1].lastAccess);
    for (const [listenerId, entry] of eligible) {
      if (this.entries.size < this.max) break;
      this.entries.delete(listenerId);
      entry.show.reset?.();
    }
  }

  values() {
    return [...this.entries.values()].map((entry) => entry.show);
  }
}

const shows = new ShowRegistry();

export function showFor(listenerId) {
  return shows.get(listenerId);
}

export function allShows() {
  return shows.values();
}
