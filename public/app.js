// Longtime Listener client. Plays the episode one turn at a time, prefetching the next
// turn's audio while the current one is on air, lights the room from measured
// audio levels, and can hand the microphone to the listener mid-segment.

function apiBase() {
  const configured = document
    .querySelector('meta[name="newscast-api-base"]')
    ?.content.trim();
  if (configured) return configured.endsWith("/") ? configured : `${configured}/`;
  let p = location.pathname;
  if (/\.[a-z0-9]+$/i.test(p)) p = p.replace(/[^/]*$/, "");
  if (!p.endsWith("/")) p += "/";
  return `${p}api/`;
}

const API = apiBase();
const $ = (id) => document.getElementById(id);
const root = document.documentElement;

// Ten milliseconds of real silence: 8 kHz mono 16-bit, 80 actual PCM frames.
// Assigned to the audio element inside the very first tap so the element is
// unlocked by a genuine user gesture — by the time the first line has been fetched
// we are no longer inside that gesture and play() would be blocked. A header-only
// WAV with no frames does not reliably unlock anything, because there is nothing
// to decode and play.
const SILENCE =
  "data:audio/wav;base64,UklGRsQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
const HOST_PLAYBACK_RATE = 1.12;

const state = {
  listenerId: localStorage.getItem("newscast:listener") || null,
  // Bumped whenever the episode is torn down. Every loop and every continuation
  // checks it after an await, so work belonging to a finished episode cannot
  // write to the screen or restart playback behind the setup form.
  epoch: 0,
  // Aborts the long polls of a torn-down episode instead of waiting them out.
  abort: new AbortController(),
  show: null,
  episode: null,
  playback: null,
  statusShow: null,
  playbackComplete: false,
  saveWarningShown: false,
  sharedPreview: null,
  segment: null,
  turnIndex: 0,
  jumpTo: null,
  skipSegmentId: null, // "hurry up" — stop this one after the line on air
  paused: false,
  audio: new Audio(),
  prefetch: new Map(),
  follow: true, // the transcript scrolls itself only while the reader is at the bottom
  linePlaying: false, // a host line is mid-playback (not the silent unlock clip)
  resumeGate: null, // resolver waiting on the listener to allow audio
  audioBlocked: false,
  call: { phase: "idle", token: 0, bridgeId: null, sending: false },
  awaitingAnswerId: null, // an answer is being written; a second call would collide
  recorder: null,
  chunks: [],
  stream: null,
  sections: new Map(), // segmentId -> transcript section element
  mode: "welcome",
  transitioning: false,
};

const requestedShareId = new URLSearchParams(location.search).get("episode")?.trim() || null;
let libraryLoadToken = 0;

// The front door has one question and one answer. Its token retires every async
// continuation when the listener hangs up, chooses a preset, or changes podcast.
const setup = {
  token: 0,
  phase: "idle",
  unlocked: null,
  premise: null,
  researchId: null,
  presetId: null,
};

state.audio.preload = "auto";
state.audio.crossOrigin = "anonymous";

function configureHostPlayback(audio) {
  audio.defaultPlaybackRate = HOST_PLAYBACK_RATE;
  audio.playbackRate = HOST_PLAYBACK_RATE;
  // Browser-specific aliases cover older Safari and Firefox releases. This affects
  // only host playback; microphone capture remains at the device's native rate.
  audio.preservesPitch = true;
  if ("webkitPreservesPitch" in audio) audio.webkitPreservesPitch = true;
  if ("mozPreservesPitch" in audio) audio.mozPreservesPitch = true;
}

configureHostPlayback(state.audio);

async function api(pathname, { method = "GET", body, raw, headers = {}, signal, withListener = true } = {}) {
  const res = await fetch(API + pathname, {
    method,
    signal: signal ?? state.abort.signal,
    headers: {
      ...(withListener && state.listenerId ? { "x-listener-id": state.listenerId } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  if (res.status === 204) return null;
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(json?.error || `${res.status} ${res.statusText}`);
  return json;
}

function adoptListener(listenerId) {
  if (!listenerId) return;
  state.listenerId = listenerId;
  localStorage.setItem("newscast:listener", listenerId);
  $("toggle-profile").hidden = false;
}

function toast(message, ms = 3400) {
  const el = $("toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    el.hidden = true;
  }, ms);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- the room: measured audio levels ---------------- */

/**
 * Everything here is optional decoration wrapped around something that is not:
 * the audio element the whole show plays through. Routing an element into a Web
 * Audio graph is one-way and it silences the element if the graph is not connected
 * to the destination or the context is suspended — so the rule is that the graph
 * is only ever built when the context is genuinely running, every failure path
 * leaves the element playing on its own, and a context that suspends later is
 * resumed rather than left to mute the show.
 */
const room = {
  ctx: null,
  source: null,
  analyser: null,
  data: null,
  mic: null,
  micData: null,
  level: 0,
  micLevel: 0,
  running: false,
};

/** Called inside the listener's first tap, where an AudioContext is allowed to start. */
function openAudioContext() {
  if (room.ctx || reducedMotion) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    room.ctx = new Ctx();
    room.ctx.resume?.().catch(() => {});
  } catch {
    room.ctx = null;
  }
}

/** Wire the show's audio element into the graph. Once only, and only if safe. */
function attachRoomAnalyser() {
  if (!room.ctx || room.source || room.ctx.state !== "running") return;
  try {
    room.source = room.ctx.createMediaElementSource(state.audio);
    room.analyser = room.ctx.createAnalyser();
    room.analyser.fftSize = 512;
    room.data = new Uint8Array(room.analyser.fftSize);
    room.source.connect(room.analyser);
    // Without this the element is now routed nowhere and the show goes silent.
    room.analyser.connect(room.ctx.destination);
    startRoomLoop();
  } catch {
    room.source = null;
    room.analyser = null;
  }
}

/**
 * A suspended context mutes an element that has been routed through it, so this
 * runs before every play and whenever the tab comes back.
 */
function keepContextAwake() {
  if (room.ctx && room.ctx.state === "suspended") room.ctx.resume?.().catch(() => {});
}

function rmsOf(analyser, buffer) {
  analyser.getByteTimeDomainData(buffer);
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) {
    const v = (buffer[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / buffer.length);
}

function startRoomLoop() {
  if (room.running || reducedMotion) return;
  room.running = true;
  const tick = () => {
    // Speech sits around 0.05–0.2 RMS; the gain brings that into a usable 0..1 and
    // the lerp keeps it breathing rather than strobing on every frame.
    const target =
      room.analyser && state.linePlaying && !state.paused
        ? Math.min(1, rmsOf(room.analyser, room.data) * 4.5)
        : 0;
    room.level += (target - room.level) * (target > room.level ? 0.35 : 0.08);
    root.style.setProperty("--glow", room.level.toFixed(3));

    const micTarget = room.mic ? Math.min(1, rmsOf(room.mic, room.micData) * 5) : 0;
    room.micLevel += (micTarget - room.micLevel) * (micTarget > room.micLevel ? 0.4 : 0.1);
    root.style.setProperty("--glow-mic", room.micLevel.toFixed(3));

    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** The listener's own voice. Analysed only — never connected to the speakers. */
function attachMicAnalyser(stream) {
  if (!room.ctx || room.ctx.state !== "running") return;
  try {
    const src = room.ctx.createMediaStreamSource(stream);
    const analyser = room.ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser); // and nowhere else: connecting to destination is feedback
    room.mic = analyser;
    room.micData = new Uint8Array(analyser.fftSize);
    room.micSource = src;
    startRoomLoop();
  } catch {
    room.mic = null;
  }
}

function detachMicAnalyser() {
  try {
    room.micSource?.disconnect();
  } catch {
    /* already gone */
  }
  room.mic = null;
  room.micSource = null;
  room.micLevel = 0;
  root.style.setProperty("--glow-mic", "0");
}

function setGlowSpeaker(speaker) {
  root.style.setProperty(
    "--glow-color",
    speaker === "dev"
      ? "var(--dev)"
      : speaker === "producer"
        ? "var(--producer)"
        : speaker === "ari"
          ? "var(--ari)"
          : "var(--amber)",
  );
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) keepContextAwake();
});

/* ---------------- transcript ---------------- */

const KIND_LABEL = {
  opening: "Top of the episode",
  topic: "Now on air",
  bridge: "Taking a call",
  caller: "On the line",
  notice: "Desk note",
};

function labelFor(segment) {
  if (segment.kind === "bridge" && segment.bridgeRole === "hold") return "Looking it up";
  return KIND_LABEL[segment.kind] ?? "On air";
}

/** Segment changes never replace the series and episode identity at the top. */
function renderNow(segment) {
  $("studio").classList.toggle("researching", !!segment.researching);
}

/** One block of transcript per segment. Evidence remains on the server. */
function sectionFor(segment) {
  const existing = state.sections.get(segment.id);
  if (existing) return existing;
  const el = document.createElement("section");
  el.className = "tsection";
  el.dataset.segment = segment.id;

  const header = document.createElement("header");
  const kicker = document.createElement("span");
  kicker.className = "kicker";
  kicker.textContent = labelFor(segment);
  const title = document.createElement("h3");
  title.textContent = segment.kind === "caller" ? "Your question" : segment.title || "";
  header.append(kicker, title);

  const lines = document.createElement("div");
  lines.className = "lines";
  el.append(header, lines);
  $("transcript").append(el);
  state.sections.set(segment.id, el);
  trimTranscript();
  return el;
}

function appendTurn(segment, turn, index) {
  const key = `${segment.id}:${index}`;
  const section = sectionFor(segment);
  const existing = section.querySelector(`[data-key="${CSS.escape(key)}"]`);
  if (existing) return existing; // a re-delivered segment must not double-print
  const el = document.createElement("div");
  el.className = "line";
  el.dataset.speaker = turn.speaker;
  el.dataset.key = key;
  const who = document.createElement("div");
  who.className = "who";
  who.textContent =
    turn.name || { ari: "Ari", dev: "Dev", producer: "Sam", caller: "You" }[turn.speaker] || "Host";
  const text = document.createElement("p");
  text.className = "said-text";
  text.textContent = turn.text;
  el.append(who, text);
  section.querySelector(".lines").append(el);
  return el;
}

function renderReplayEnded() {
  if ($("replay-ended")) return;
  const section = document.createElement("section");
  section.id = "replay-ended";
  section.className = "tsection replay-ended";
  const kicker = document.createElement("p");
  kicker.className = "kicker";
  kicker.textContent = "Saved episode";
  const title = document.createElement("h3");
  title.textContent = "End of saved episode";
  const copy = document.createElement("p");
  copy.textContent = state.playback?.shared
    ? "Call in to continue with your own version, or choose another podcast."
    : "Call in to continue from here, or choose another episode from My podcasts.";
  section.append(kicker, title, copy);
  $("transcript").append(section);
  scrollToLatest(section);
}

function clearReplayEnded() {
  document.getElementById("replay-ended")?.remove();
  state.playbackComplete = false;
}

/**
 * What the listener said, as its own entry in the transcript.
 *
 * It has to be a section of its own, not a line inside the answer. The answer is
 * two segments away — the hold line comes first — so hanging the question off it
 * builds the answer's block early and every host line then lands *above* the "let
 * me look that up", leaving the transcript reading answer-then-hold. Spoken in this
 * order, printed in this order.
 */
function callerSectionId(answerSegmentId) {
  return `you_${answerSegmentId}`;
}

function appendCallerQuestion(answerSegmentId, question, beforeSegmentId = null) {
  const id = callerSectionId(answerSegmentId);
  if (state.sections.has(id)) return;
  const el = document.createElement("section");
  el.className = "tsection";
  el.dataset.segment = id;

  const header = document.createElement("header");
  const kicker = document.createElement("span");
  kicker.className = "kicker";
  kicker.textContent = "You called in";
  header.append(kicker);

  const lines = document.createElement("div");
  lines.className = "lines";
  const line = document.createElement("div");
  line.className = "line you said";
  line.dataset.key = `you:${answerSegmentId}`;
  const who = document.createElement("div");
  who.className = "who";
  who.textContent = "You";
  const text = document.createElement("p");
  text.className = "said-text";
  text.textContent = question;
  line.append(who, text);
  lines.append(line);

  el.append(header, lines);
  // A waiting /next request can render the hold before /call/submit returns.
  // Keep the caller ahead of that hold even when the HTTP responses race.
  $("transcript").insertBefore(el, state.sections.get(beforeSegmentId) ?? null);
  state.sections.set(id, el);
  trimTranscript();
  scrollToLatest(line);
}

/**
 * Drop the oldest sections, but only while the reader is at the bottom. Removing a
 * section above the viewport shifts everything under it, which is the same yank as
 * an autoscroll — and it happens to someone who has deliberately scrolled back to
 * read something. Held over until they return to live.
 */
function trimTranscript() {
  if (!state.follow) return;
  const t = $("transcript");
  // The hidden welcome subtree and the listener's initial topic are permanent
  // shell content. Count and trim only generated episode sections.
  const generated = [...t.children].filter((child) => child.dataset.segment);
  while (generated.length > 14) {
    const oldest = generated.shift();
    state.sections.delete(oldest.dataset.segment);
    oldest.remove();
  }
}

/**
 * Follow the show only while the reader is already at the bottom. Scrolling up is
 * a deliberate act and the transcript must not drag them back down out of it.
 */
function scrollToLatest(node) {
  if (!state.follow) return;
  node.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "nearest" });
}

$("transcript").addEventListener("scroll", () => {
  const t = $("transcript");
  const nearBottom = t.scrollHeight - t.scrollTop - t.clientHeight < 90;
  state.follow = nearBottom;
  $("to-live").hidden = nearBottom;
});

$("to-live").addEventListener("click", () => {
  const t = $("transcript");
  state.follow = true;
  $("to-live").hidden = true;
  trimTranscript(); // deferred while they were reading; safe to catch up now
  t.scrollTo({ top: t.scrollHeight, behavior: reducedMotion ? "auto" : "smooth" });
});

function markSpeaking(speaker) {
  setGlowSpeaker(speaker);
  $("onair").classList.toggle("live", !!speaker && !state.paused);
}

/* ---------------- playback ---------------- */

/**
 * The listener id travels in the query string because an <audio> element issues its
 * own request and cannot carry the header the rest of the API uses.
 */
function audioUrl(segmentId, index) {
  return `${API}audio/${encodeURIComponent(segmentId)}/${index}?listener=${encodeURIComponent(
    state.listenerId ?? "",
  )}`;
}

function prefetchAudio(segmentId, index) {
  const key = `${segmentId}:${index}`;
  if (state.prefetch.has(key)) return;
  const a = new Audio();
  a.preload = "auto";
  a.src = audioUrl(segmentId, index);
  a.load();
  state.prefetch.set(key, a);
  if (state.prefetch.size > 6) {
    state.prefetch.delete(state.prefetch.keys().next().value);
  }
}

/**
 * Ask the listener to let audio through, and start playback from inside their click.
 * The play() call has to happen synchronously in the gesture handler — resolving a
 * promise first and calling play() afterwards is outside the gesture, and gets
 * blocked exactly like the attempt that brought us here.
 */
function showResumeGate(reason, audio, epoch, { primeWithSilence = false } = {}) {
  state.audioBlocked = true;
  $("studio").classList.add("audio-blocked");
  renderPauseLabel();
  return new Promise((resolve) => {
    // Ending the episode settles the in-dock prompt too, so a retired line cannot
    // restart after a new podcast or episode has taken over the shell.
    state.dismissResumeGate = () => {
      state.resumeGate = null;
      state.dismissResumeGate = null;
      state.audioBlocked = false;
      $("studio").classList.remove("audio-blocked");
      renderPauseLabel();
      resolve(false);
    };
    state.resumeGate = () => {
      state.resumeGate = null;
      state.dismissResumeGate = null;
      state.audioBlocked = false;
      $("studio").classList.remove("audio-blocked");
      $("setup-status").textContent = "";
      renderPauseLabel();
      // The tap can arrive long after the episode it belonged to ended. Playing
      // here would restart a line from a show that is no longer on.
      if (epoch !== undefined && epoch !== state.epoch) {
        resolve(false);
        return;
      }
      openAudioContext();
      keepContextAwake();
      // Launch gates have no host line to resume. A real silent clip makes the
      // gesture settle without replaying the welcome or acknowledgement.
      if (primeWithSilence || (!audio.getAttribute("src") && !audio.currentSrc)) {
        audio.pause();
        audio.src = SILENCE;
        state.linePlaying = false;
      }
      let started;
      try {
        started = audio.play(); // synchronous, still inside the click
      } catch {
        resolve(false);
        return;
      }
      Promise.resolve(started).then(
        () => resolve(true),
        () => resolve(false),
      );
    };
  });
}

async function waitWhilePaused(epoch) {
  while (state.paused && epoch === state.epoch) await sleep(150);
}

/**
 * Play one line to its end. A blocked or failed play is never reported as heard —
 * that would march silently through the episode. Blocked audio raises the resume
 * gate and keeps the same line loaded; only a genuinely unplayable line is given
 * up on.
 */
async function playTurn(segmentId, index, epoch) {
  const audio = state.audio;
  const url = audioUrl(segmentId, index);

  let cancel = null;
  const release = () => {
    // Only the play that installed it may clear it: a later turn owns the slot by
    // the time a cancelled one gets here.
    if (state.cancelTurn === cancel) state.cancelTurn = null;
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    await waitWhilePaused(epoch);
    if (epoch !== state.epoch) {
      release();
      return { heard: false, heardSeconds: 0 };
    }
    keepContextAwake();

    audio.onended = null;
    audio.onerror = null;
    audio.src = url;
    configureHostPlayback(audio);

    const outcome = await new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        state.linePlaying = false;
        audio.onended = null;
        audio.onerror = null;
        resolve(value);
      };
      audio.onended = () => finish("ended");
      audio.onerror = () => finish("error");
      // Ending the episode pauses the element and drops its source, and neither
      // fires `ended` or `error` — so without a way to settle this from outside,
      // the promise never resolves and the loop it belongs to is stuck forever.
      cancel = () => finish("cancelled");
      state.cancelTurn = cancel;

      // Marks this element as carrying a host line, so a Resume tap knows there is
      // something to resume and does not replay a line that already ended.
      state.linePlaying = true;

      const tryPlay = () =>
        audio.play().then(
          () => attachRoomAnalyser(),
          async (err) => {
            if (err?.name !== "NotAllowedError" || settled) {
              finish("error");
              return;
            }
            // The source stays loaded; the listener's click restarts this same line.
            const allowed = await showResumeGate("Your browser paused the audio.", audio, epoch);
            if (epoch !== state.epoch) {
              finish("cancelled");
              return;
            }
            if (!allowed && !settled) {
              await sleep(400);
              if (epoch !== state.epoch) {
                finish("cancelled");
                return;
              }
              tryPlay();
            }
          },
        );
      tryPlay();
    });

    if (outcome === "cancelled" || epoch !== state.epoch) {
      release();
      return { heard: false, heardSeconds: 0 };
    }
    if (outcome === "ended") {
      const playbackRate = Number.isFinite(audio.playbackRate) && audio.playbackRate > 0
        ? audio.playbackRate
        : HOST_PLAYBACK_RATE;
      const heardSeconds =
        Number.isFinite(audio.duration) && audio.duration > 0
          ? audio.duration / playbackRate
          : 0;
      release();
      return { heard: true, heardSeconds };
    }
    if (attempt === 0) {
      await sleep(600); // the line may still be rendering: give it one more go
      if (epoch !== state.epoch) {
        release();
        return { heard: false, heardSeconds: 0 };
      }
      continue;
    }
    release();
    toast("Skipped a line — its audio would not load.");
    return { heard: false, heardSeconds: 0 };
  }
  release();
  return { heard: false, heardSeconds: 0 };
}

async function ensureTurn(segment, index) {
  if (segment.turns[index] || segment.complete) return segment;
  const fresh = await api(`segment/${segment.id}?from=${segment.turns.length}`);
  segment.turns.push(...fresh.turns);
  segment.complete = fresh.complete;
  segment.cancelled = fresh.cancelled;
  segment.abandoned = fresh.abandoned;
  segment.researching = fresh.researching;
  if (fresh.sources?.length) {
    segment.sources = fresh.sources;
    if (state.segment?.id === segment.id) renderNow(segment);
  }
  return segment;
}

/** A caller was accepted, the listener hurried us on, or the episode is over. */
function stale(segment, epoch) {
  return (
    epoch !== state.epoch ||
    !!state.jumpTo ||
    state.skipSegmentId === segment.id ||
    segment.cancelled ||
    segment.abandoned
  );
}

async function playSegment(segment, epoch) {
  state.segment = segment;
  if (state.awaitingAnswerId === segment.id) {
    state.awaitingAnswerId = null; // the answer is on air; calling in is available again
    renderCall();
  }
  renderNow(segment);
  // On a reload the standalone entry is gone, so the answer segment carries the
  // question and prints it here instead — by then the hold line is already above
  // it, so the order still reads correctly.
  if (segment.callerQuestion && !state.sections.has(callerSectionId(segment.id))) {
    appendCallerQuestion(segment.id, segment.callerQuestion);
  }
  sectionFor(segment);

  const start = segment.resumeFrom ?? 0;
  // Turns already heard before a reload: show them, do not replay them.
  for (let i = 0; i < start && segment.turns[i]; i++) {
    appendTurn(segment, segment.turns[i], i).classList.add("said");
  }

  let i = start;
  while (true) {
    if (stale(segment, epoch)) break;
    await ensureTurn(segment, i);
    // Re-check after the await: a call can land while we are waiting on a turn,
    // and playing the next line of a dropped subject is exactly the bug.
    if (stale(segment, epoch)) break;

    const turn = segment.turns[i];
    if (!turn) {
      if (segment.complete) break; // the script really did end here
      // The poll timed out with this turn still unwritten. Ask again for the SAME
      // index — advancing would step over a line that is about to arrive.
      await sleep(250);
      continue;
    }

    await waitWhilePaused(epoch);
    if (stale(segment, epoch)) break;

    state.turnIndex = i;
    const node = appendTurn(segment, turn, i);
    node.classList.add("current");
    scrollToLatest(node);
    markSpeaking(turn.speaker);

    // On air now — moves the caller's frame of reference, claims nothing about
    // whether it was heard.
    postProgress(segment.id, i, "started").catch(() => {});
    if (segment.turns[i + 1]) prefetchAudio(segment.id, i + 1);

    const playback = await playTurn(segment.id, i, epoch);
    const heard = playback.heard;
    if (epoch !== state.epoch) return;

    // The invitation has just finished playing. Recording starts *here*, before the
    // progress report, because that report is a network round trip — and on a phone
    // it is long enough to swallow the first words of someone who started talking
    // the moment they heard "caller, you're on".
    const lastTurn = segment.complete && i >= segment.turns.length - 1;
    if (segment.bridgeRole === "handoff" && lastTurn && ["queued", "inviting"].includes(state.call.phase)) {
      await openMicrophone();
    }

    node.classList.remove("current");
    node.classList.add("said");
    markSpeaking(null);

    // Awaited, not fired and forgotten: the very next thing we may do is ask for the
    // following segment, and that decision reads the resume point this call sets.
    await postProgress(
      segment.id,
      i,
      heard ? "finished" : "skipped",
      heard ? playback.heardSeconds : undefined,
    ).catch(() => {});

    // The line finishes before we cut away — that is the point of the bridge, and
    // it is what "the hosts finish a short turn and invite you in" means.
    if (stale(segment, epoch)) break;
    if (segment.complete && i >= segment.turns.length - 1) break;
    i += 1;
  }

  if (epoch !== state.epoch) return;
  if (state.skipSegmentId === segment.id) state.skipSegmentId = null;

  // Fallback for an invitation that ended without a turn playing to completion —
  // audio that would not load, for instance. The listener still has to be able to
  // speak; the recorder just starts a beat later than it would have.
  if (segment.bridgeRole === "handoff" && ["queued", "inviting"].includes(state.call.phase)) {
    await openMicrophone();
  }
}

function postProgress(segmentId, turnIndex, phase, heardSeconds) {
  const epoch = state.epoch;
  return api("progress", {
    method: "POST",
    body: {
      segmentId,
      turnIndex,
      phase,
      ...(phase === "finished" && Number.isFinite(heardSeconds) && heardSeconds > 0
        ? { heardSeconds }
        : {}),
    },
  }).then((result) => {
    if (epoch === state.epoch) state.saveWarningShown = false;
    return result;
  }).catch((err) => {
    if (epoch === state.epoch && err.name !== "AbortError" && !state.saveWarningShown) {
      state.saveWarningShown = true;
      toast("Your latest progress couldn't be saved. We'll retry as you listen.", 6000);
    }
    throw err;
  });
}

/**
 * One loop per episode. `epoch` is checked after every await: tearing an episode
 * down aborts the long poll this is sitting in, and without the check the old loop
 * would come back from that abort and carry on playing the previous show behind
 * the setup form.
 */
async function showLoop(epoch) {
  while (epoch === state.epoch) {
    try {
      if (state.jumpTo) {
        const id = state.jumpTo;
        state.jumpTo = null;
        const segment = await api(`segment/${id}`);
        if (epoch !== state.epoch) return;
        await playSegment(segment, epoch);
        continue;
      }
      const segment = await api(`${state.playback?.replay ? "replay/next" : "next"}?wait=30000`);
      if (epoch !== state.epoch) return;
      if (!segment) continue;
      if (segment.episodeEnded) {
        state.playbackComplete = true;
        renderReplayEnded();
        // A call can branch a replay at its confirmed-heard prefix. Keep this loop
        // alive without hammering /next so its invitation or answer can resume here.
        while (epoch === state.epoch && !state.jumpTo) await sleep(250);
        if (epoch !== state.epoch) return;
        clearReplayEnded();
        continue;
      }
      await playSegment(segment, epoch);
    } catch (err) {
      if (epoch !== state.epoch || err.name === "AbortError") return;
      console.error(err);
      toast(err.message.slice(0, 140), 5000);
      await sleep(2500);
    }
  }
}

function renderPauseLabel() {
  let label = state.paused ? "Resume" : "Pause";
  if (state.audioBlocked) label = "Start listening";
  $("pause-label").textContent = label;
}

function setPaused(paused) {
  state.paused = paused;
  renderPauseLabel();
  $("pause").setAttribute("aria-pressed", String(paused));
  $("studio").classList.toggle("paused", paused);
  if (paused) {
    state.audio.pause();
  } else if (state.linePlaying && !state.audio.ended) {
    // Only resume a line that is genuinely mid-flight. Between turns the element
    // still holds the previous line, and playing it again repeats it; the silent
    // unlock clip is not a host line at all.
    keepContextAwake();
    state.audio.play().catch(() => {});
  }
  $("onair").classList.toggle("live", !paused && state.linePlaying);
}

function handlePause() {
  if (state.transitioning) return;
  if (state.resumeGate) return state.resumeGate();
  if (state.mode === "welcome") return;
  setPaused(!state.paused);
}

/* ---------------- call-in ---------------- */

/**
 * The call has one identity for its whole life, and every asynchronous
 * continuation checks it before touching anything. Hanging up during an upload is
 * the case this exists for: the request is already in flight, and its success
 * handler would otherwise print the caller's question, jump the show to an answer
 * nobody is waiting for, and un-pause a listener who has walked away.
 */
let callToken = 0;
const callAlive = (token) => token === callToken && state.call.phase !== "idle";

function renderCall() {
  const phase = state.call.phase;
  const defining = state.mode === "welcome";
  $("dock-controls").hidden = phase !== "idle";
  $("call-sheet").hidden = phase === "idle";
  $("call-sheet").classList.toggle("listening", phase === "live");
  $("call-text").hidden = phase !== "typed";
  $("call-done").disabled = !["live", "typed"].includes(phase);
  const canSwitchToTyping = defining
    ? ["queued", "inviting", "live"].includes(phase)
    : phase === "live";
  $("call-type").hidden = !canSwitchToTyping;
  // The button that starts a call stays disabled until the last one is finished
  // with, so a second tap cannot replay an invitation or collide with an answer
  // that is still being written.
  $("call-in").disabled = phase !== "idle" || !!state.awaitingAnswerId || state.transitioning;
  $("open-library").disabled = phase !== "idle" || state.transitioning;
  $("welcome-library").disabled = phase !== "idle" || state.transitioning;
  $("call-label").textContent = state.awaitingAnswerId
    ? "With the hosts"
    : defining
      ? "Speak your answer"
      : "Call in";

  if (phase === "queued") {
    $("call-state").textContent = defining ? "Calling in" : "On the board";
    // Deliberately not "you're on": the hosts have not handed over and the
    // recorder is not running. Saying otherwise invites them to talk into nothing.
    $("call-copy").textContent = defining
      ? "Getting your microphone ready…"
      : "You're in the queue — the hosts are finishing their thought.";
  } else if (phase === "inviting") {
    $("call-state").textContent = defining ? "Ari's with you" : "On the board";
    $("call-copy").textContent = defining ? "Listen for your cue…" : "They're handing over now…";
  } else if (phase === "live") {
    $("call-state").textContent = defining ? "Ready" : "You're on air";
    $("call-copy").textContent = defining
      ? "We're listening. Say your topic, then tap Done speaking."
      : "Go ahead — say it, then tap Done speaking.";
  } else if (phase === "typed") {
    $("call-state").textContent = defining ? "Type your idea" : "Type your call";
    $("call-copy").textContent = defining
      ? "What are you interested in hearing about?"
      : "Type what you want to ask them instead.";
  } else if (phase === "sending") {
    $("call-state").textContent = defining ? "Building your podcast" : "Handing it over";
    $("call-copy").textContent = defining ? "Naming the series and its first episode…" : "One second…";
  } else if (phase === "switching") {
    $("call-state").textContent = "Switching input";
    $("call-copy").textContent = "Closing the microphone…";
  }
}

/**
 * The tap. The board lights up immediately and the microphone permission prompt
 * goes up with it — while the hosts keep talking. Nothing on air is disturbed
 * until there is a recorder ready, because the invitation is the listener's cue to
 * start speaking and a cue that arrives before the recorder does costs them their
 * first sentence.
 */
async function tapCallIn() {
  if (state.call.phase !== "idle" || state.awaitingAnswerId || state.transitioning) return;
  if (state.mode === "welcome") return beginSetupCall();
  const token = ++callToken;
  state.call = { phase: "queued", token, bridgeId: null, sending: false };
  renderCall();
  // Calling in from a paused show has to resume it: the invitation is a host line,
  // and the recorder starts when that line ends. Left paused, the board would sit
  // lit forever with nothing to end.
  if (state.paused) setPaused(false);

  try {
    // The board and the permission prompt, at the same moment.
    const [, stream] = await Promise.all([
      api("call/start", { method: "POST" }),
      prewarmMicrophone(),
    ]);
    if (!callAlive(token)) {
      releaseStream(stream);
      return;
    }

    // Build the recorder now, and start it only at the cue. Constructing it here is
    // what closes the gap the listener hears as "it missed my first sentence".
    const prepared = prepareRecorder(stream);
    if (!callAlive(token)) {
      releaseStream(stream);
      return;
    }
    if (!prepared) state.call.noMic = true;

    // Only now do the hosts hand over.
    const invite = await api("call/invite", { method: "POST" });
    if (!callAlive(token)) return;
    state.call.phase = "inviting";
    state.call.bridgeId = invite.jumpTo;
    renderCall();
    state.jumpTo = invite.jumpTo; // finish the line on air, then cut to the cue
  } catch (err) {
    if (!callAlive(token)) return;
    toast(err.message);
    await hangUp({ silent: true });
  }
}

/** Ask for the microphone now, hold the stream, and start nothing. */
function prewarmMicrophone() {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    return Promise.resolve(null);
  }
  // The hosts play out of the same device the caller is talking into, and the
  // recorder is prepared while a host line is still going. Asked for explicitly
  // rather than left to the browser's default.
  return navigator.mediaDevices
    .getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
    .catch(() => navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null));
}

/** Construct the recorder without starting it. Returns whether there is one. */
function prepareRecorder(stream) {
  if (!stream) return false;
  try {
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((m) =>
      MediaRecorder.isTypeSupported?.(m),
    );
    state.stream = stream;
    state.recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    state.chunks = [];
    state.recorder.ondataavailable = (e) => {
      if (e.data.size) state.chunks.push(e.data);
    };
    return true;
  } catch {
    releaseStream(stream);
    state.stream = null;
    state.recorder = null;
    return false;
  }
}

/**
 * The invitation has finished. Recording starts here, synchronously, and the cue
 * on screen goes up in the same tick — never before it, and with nothing awaited
 * in between.
 */
async function openMicrophone() {
  if (!["queued", "inviting"].includes(state.call.phase)) return;
  const token = state.call.token;
  setPaused(true); // so the hosts are not recorded talking over the caller

  if (!state.recorder) {
    state.call.phase = "typed";
    renderCall();
    $("call-text").focus({ preventScroll: true });
    return;
  }
  try {
    // Wait for `start` before the cue goes up. The recorder is constructed well in
    // advance, so this is a few milliseconds — but it is the difference between
    // "you're on air" meaning the recorder is running and meaning it is about to.
    // Timeslice, so audio is flushed as it arrives rather than only on stop.
    await new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, 500); // a recorder that never fires `start`
      state.recorder.onstart = done;
      state.recorder.start(250);
    });
    // The timeout above is a way out of a hang, not evidence of anything. Readiness
    // is the recorder saying it is recording — otherwise the cue would send someone
    // to talk into a microphone that never started.
    if (state.recorder?.state !== "recording") throw new Error("recorder did not start");
  } catch {
    if (!callAlive(token)) return;
    await stopRecording(); // close the microphone rather than leave it open and idle
    state.call.phase = "typed";
    renderCall();
    $("call-text").focus({ preventScroll: true });
    return;
  }
  if (!callAlive(token)) return;
  attachMicAnalyser(state.stream);
  state.call.phase = "live";
  renderCall();
  if (state.mode === "episode") api("call/live", { method: "POST" }).catch(() => {});
}

function releaseStream(stream) {
  for (const t of stream?.getTracks() ?? []) t.stop();
}

function stopRecording() {
  detachMicAnalyser();
  const recorder = state.recorder;
  state.recorder = null;
  const stream = state.stream;
  state.stream = null;
  const release = () => releaseStream(stream);
  if (!recorder || recorder.state === "inactive") {
    release();
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    recorder.onstop = () => {
      release();
      const blob = state.chunks.length ? new Blob(state.chunks, { type: recorder.mimeType }) : null;
      state.chunks = [];
      resolve(blob);
    };
    recorder.stop();
  });
}

/**
 * "Done speaking" sends the recording itself. There is no read-it-back-and-confirm
 * step: the listener finished talking, so it goes to the hosts, and what was heard
 * shows up in the transcript a moment later.
 */
async function doneSpeaking() {
  if (state.call.sending) return; // synchronous guard, before any await
  if (!["live", "typed"].includes(state.call.phase)) return;
  const token = state.call.token;
  // A typed setup answer has not needed audio yet. Its submit tap is the gesture
  // that unlocks the first generated line, so do this before the first await.
  const setupUnlock = state.mode === "welcome" ? unlockFromGesture() : null;
  state.call.sending = true;
  const wasPhase = state.call.phase;
  state.call.phase = "sending";
  renderCall();

  try {
    const blob = await stopRecording();
    if (!callAlive(token)) return;
    const typed = $("call-text").value.trim();
    if (state.mode === "welcome") {
      await submitSetupAnswer({ blob, typed, token, unlocked: setupUnlock });
      return;
    }
    let result;
    if (blob && blob.size > 800) {
      result = await api("call/submit", {
        method: "POST",
        raw: blob,
        headers: { "content-type": blob.type || "audio/webm" },
      });
    } else if (typed) {
      result = await api("call/submit", { method: "POST", body: { question: typed } });
    } else {
      throw new Error("Nothing came through — say it again, or type it.");
    }
    // They hung up while this was uploading. The server has been told; do not put
    // their question on screen or drag the show to an answer they walked away from.
    if (!callAlive(token)) return;

    if (result.forked && result.episodeId) {
      const parent = state.episode || {};
      state.episode = {
        ...parent,
        id: result.episodeId,
        parentEpisodeId: parent.id || null,
        parentEpisodeTitle: parent.episodeTitle || state.show?.episodeTitle || null,
        isBranch: true,
        shareId: null,
      };
      state.playback = { from: "resume", readOnly: false, replay: false, shared: false };
      state.statusShow = {
        ...(state.statusShow || {}),
        episodeId: result.episodeId,
        parentEpisodeId: state.episode.parentEpisodeId,
        readOnly: false,
        replay: false,
        shared: false,
        shareId: null,
      };
      clearSharedUrl();
      clearReplayEnded();
      renderShowIdentity(state.show, state.episode, state.playback);
      $("new-episode").hidden = false;
      $("share-current").hidden = false;
      toast("Your version is now saved separately.");
    }

    // Print what was heard straight away, keyed on the segment that carries the
    // question — the hosts' reaction to it, which starts before the answer exists
    // — so that segment does not print it a second time when it comes on air.
    appendCallerQuestion(result.coverSegmentId, result.question, result.jumpTo);
    // Bound to the answer, not to the cover. The cover starts within seconds while
    // the search is still running, and freeing the call button there just puts the
    // listener into a second call that the server refuses with a 409.
    state.awaitingAnswerId = result.answerSegmentId;
    state.jumpTo = result.jumpTo;
    state.call = { phase: "idle", token, bridgeId: null, sending: false };
    $("call-text").value = "";
    renderCall();
    setPaused(false);
    loadLibrary();
  } catch (err) {
    if (!callAlive(token)) return;
    state.call.sending = false;
    state.call.phase = wasPhase === "live" ? "typed" : wasPhase;
    renderCall();
    $("call-state").textContent = "That didn't go through";
    $("call-copy").textContent = err.message;
  }
}

/** Hang up, deny, or double-tap the way out. Never leaves the microphone open. */
async function hangUp({ silent = false } = {}) {
  if (state.call.phase === "idle" && !state.awaitingAnswerId) return;
  const wasEpisode = state.mode === "episode";
  // Retiring the token is what makes every continuation still in flight — the
  // upload, the permission prompt, the invitation request — return quietly.
  callToken += 1;
  if (!wasEpisode) setup.token += 1;
  state.call = { phase: "idle", token: callToken, bridgeId: null, sending: false };
  state.awaitingAnswerId = null;
  renderCall();
  $("call-text").value = "";
  await stopRecording();
  setPaused(false);
  if (!wasEpisode) {
    setup.phase = "idle";
    setSetupStatus("");
  }
  if (silent || !wasEpisode) return;
  try {
    const result = await api("call/cancel", { method: "POST", body: { reason: "hung up" } });
    if (result?.jumpTo) state.jumpTo = result.jumpTo;
  } catch {
    /* the episode carries on regardless */
  }
}

/* ---------------- pacing ---------------- */

async function nudge(action) {
  const segment = state.segment;
  if (!segment) return;
  try {
    const result = await api("pace", { method: "POST", body: { segmentId: segment.id, action } });
    if (action === "hurry") {
      // Stop after the line currently playing; the server has already dropped the
      // rest of this segment.
      state.skipSegmentId = segment.id;
      toast("Right — moving on.");
    } else {
      toast("Looking deeper into this.");
    }
  } catch (err) {
    toast(err.message);
  }
}

/* ---------------- profile ---------------- */

const PACE_TEXT = {
  "-2": "You keep asking them to hurry — segments are as short as they go.",
  "-1": "Leaning short. The hosts keep it tight.",
  0: "Default pace.",
  1: "Leaning long. The hosts go past the summary.",
  2: "You want depth — segments run as long as they get.",
};

function chip(row, { removable = true, legacy = false } = {}) {
  const li = document.createElement("li");
  if (row.score < 0) li.classList.add("cool");
  if (legacy) li.classList.add("legacy");
  const label = document.createElement("span");
  label.textContent = row.label;
  const note = document.createElement("span");
  note.className = "weight";
  note.textContent = row.score < 0 ? "hearing less" : legacy ? "" : row.why || "";
  li.append(label);
  if (note.textContent) li.append(note);
  if (removable) {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Forget ${row.label}`);
    remove.addEventListener("click", async () => {
      await api("profile/interest", {
        method: "POST",
        body: { label: row.label, kind: row.kind, remove: true },
      });
      loadProfile();
    });
    li.append(remove);
  }
  return li;
}

async function loadProfile() {
  const profile = await api("profile");
  $("profile-brief").textContent = profile.brief;
  $("pace-readout").textContent = PACE_TEXT[String(profile.pacing ?? 0)] ?? PACE_TEXT[0];

  // Split by the podcast that is on air, and ranked and limited separately, so a
  // pile of interests from another show cannot fill the panel and hide the ones
  // belonging to this one.
  const flatten = (group) => [
    ...group.topics.map((t) => ({ ...t, kind: "topic" })),
    ...group.entities.map((t) => ({ ...t, kind: "entity" })),
  ];
  const explained = flatten(profile.interests);
  const elsewhere = flatten(profile.elsewhere ?? { topics: [], entities: [] });

  const list = $("interest-list");
  list.replaceChildren();
  if (!explained.length) {
    const li = document.createElement("li");
    li.className = "cool";
    li.textContent = "Nothing yet — call in, or add one below.";
    list.append(li);
  }
  for (const row of explained) list.append(chip(row));

  $("elsewhere-block").hidden = !elsewhere.length;
  const elsewhereList = $("elsewhere-list");
  elsewhereList.replaceChildren();
  for (const row of elsewhere) elsewhereList.append(chip(row, { legacy: true }));

  const calls = $("callin-list");
  calls.replaceChildren();
  for (const c of profile.callIns.slice(0, 6)) {
    calls.append(Object.assign(document.createElement("li"), { textContent: c.text }));
  }
  if (!profile.callIns.length) {
    calls.append(Object.assign(document.createElement("li"), { textContent: "No calls yet." }));
  }

}

/* ---------------- saved podcasts ---------------- */

function normalizeStatusShow(status) {
  // GET /status wraps Show.status() once; open/new-episode envelopes carry
  // Show.status() directly. Walk only those known wrappers to the archive identity.
  let candidate = status;
  while (candidate?.show && typeof candidate.show === "object" && !candidate.episodeId) {
    candidate = candidate.show;
  }
  return candidate && typeof candidate === "object" ? candidate : null;
}

function currentEpisodeId() {
  return state.episode?.id || state.statusShow?.episodeId || null;
}

function setLibraryOpen(open) {
  const panel = $("library");
  panel.hidden = !open;
  $("open-library").setAttribute("aria-expanded", String(open));
  $("welcome-library").setAttribute("aria-expanded", String(open));
  if (!open) return;
  $("profile").hidden = true;
  $("toggle-profile").setAttribute("aria-expanded", "false");
  loadLibrary({ announce: true });
  $("close-library").focus({ preventScroll: true });
}

function formatEpisodeDate(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return "Saved episode";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  }).format(date);
}

function makeButton(label, className, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function renderLibrary(podcasts) {
  const list = $("library-list");
  list.replaceChildren();
  $("library-status").hidden = true;

  if (!podcasts.length) {
    const empty = document.createElement("p");
    empty.className = "library-empty";
    empty.textContent = "Your finished and in-progress episodes will appear here.";
    list.append(empty);
    return;
  }

  for (const podcast of podcasts) {
    const card = document.createElement("section");
    card.className = "library-podcast";
    const head = document.createElement("header");
    const identity = document.createElement("div");
    const label = document.createElement("p");
    label.className = "kicker";
    label.textContent = "Podcast";
    const title = document.createElement("h3");
    title.textContent = podcast.title || podcast.about || "Untitled podcast";
    identity.append(label, title);
    const episodes = Array.isArray(podcast.episodes) ? podcast.episodes : [];
    const newEpisode = makeButton("New episode", "ghost", (event) => {
      const anchor = episodes[0]?.id;
      if (anchor) startNewEpisode(event, anchor);
    });
    newEpisode.disabled = !episodes[0]?.id;
    head.append(identity, newEpisode);
    card.append(head);

    if (podcast.brief || podcast.about) {
      const brief = document.createElement("p");
      brief.className = "library-podcast-brief";
      brief.textContent = podcast.brief || podcast.about;
      card.append(brief);
    }

    const episodeList = document.createElement("ol");
    episodeList.className = "library-episodes";
    for (const episode of episodes) {
      const row = document.createElement("li");
      row.className = "library-episode";
      const copy = document.createElement("div");
      copy.className = "library-episode-copy";
      const meta = document.createElement("p");
      meta.className = "library-episode-meta";
      const number = Number.isFinite(episode.episodeNumber) ? `Episode ${episode.episodeNumber}` : "Episode";
      meta.textContent = `${number} · ${formatEpisodeDate(episode.createdAt)}`;
      const episodeTitle = document.createElement("h4");
      episodeTitle.textContent = episode.episodeTitle || "Untitled episode";
      copy.append(meta, episodeTitle);
      if (episode.isBranch || episode.parentEpisodeId) {
        const branch = document.createElement("p");
        branch.className = "branch-label";
        branch.textContent = episode.parentEpisodeTitle
          ? `Your version of “${episode.parentEpisodeTitle}”`
          : "Your version of an earlier episode";
        copy.append(branch);
      }

      const actions = document.createElement("div");
      actions.className = "library-episode-actions";
      const heard = Number(episode.heardTurnCount) > 0;
      const complete = Number(episode.turnCount) > 0 && Number(episode.heardTurnCount) >= Number(episode.turnCount);
      if (heard && !complete) {
        actions.append(
          makeButton("Continue", "primary compact", (event) =>
            openSavedEpisode(episode.id, "resume", event.currentTarget),
          ),
          makeButton("From beginning", "ghost", (event) =>
            openSavedEpisode(episode.id, "start", event.currentTarget),
          ),
        );
      } else {
        actions.append(
          makeButton(complete ? "Listen again" : "Listen from beginning", "primary compact", (event) =>
            openSavedEpisode(episode.id, "start", event.currentTarget),
          ),
        );
      }
      actions.append(
        makeButton("Share", "ghost", (event) =>
          shareEpisode(episode, event.currentTarget, { ownedEpisode: true }),
        ),
      );
      row.append(copy, actions);
      episodeList.append(row);
    }
    card.append(episodeList);
    list.append(card);
  }
}

async function loadLibrary({ announce = false } = {}) {
  const token = ++libraryLoadToken;
  if (!state.listenerId) {
    if (token === libraryLoadToken) renderLibrary([]);
    return;
  }
  if (announce) {
    $("library-status").hidden = false;
    $("library-status").textContent = "Loading your podcasts…";
  }
  try {
    const result = await api("episodes");
    if (token !== libraryLoadToken) return;
    renderLibrary(Array.isArray(result?.podcasts) ? result.podcasts : []);
  } catch (err) {
    if (token !== libraryLoadToken) return;
    $("library-status").hidden = false;
    $("library-status").textContent = err.message;
  }
}

function shareUrlFor(shareId) {
  const url = new URL(location.href);
  url.hash = "";
  url.search = "";
  url.searchParams.set("episode", shareId);
  return url.href;
}

function showShareFallback(url) {
  setLibraryOpen(true);
  $("share-url").value = url;
  $("share-result").hidden = false;
  $("share-url").focus({ preventScroll: true });
  $("share-url").select();
}

async function shareEpisode(episode, button, { ownedEpisode = false } = {}) {
  const episodeId = episode?.id || currentEpisodeId();
  if (!episodeId || (state.playback?.shared && !ownedEpisode)) return;
  button.disabled = true;
  try {
    const result = await api(`episodes/${encodeURIComponent(episodeId)}/share`, { method: "POST" });
    const shareId = result?.shareId;
    if (!shareId) throw new Error("The share link did not come back.");
    const url = shareUrlFor(shareId);
    if (state.episode?.id === episodeId) state.episode = { ...state.episode, shareId };

    if (navigator.share) {
      try {
        await navigator.share({
          title: episode?.episodeTitle || state.show?.episodeTitle || "Longtime Listener episode",
          text: "Listen from the beginning, then call in to make your own version.",
          url,
        });
        loadLibrary();
        return;
      } catch {
        // The native sheet can be unavailable or denied. Clipboard is the quiet fallback.
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      toast("Share link copied.");
    } catch {
      showShareFallback(url);
    }
    loadLibrary();
  } catch (err) {
    toast(err.message);
  } finally {
    button.disabled = false;
  }
}

async function activateOpenedEpisode(opened, audioAllowed, epoch) {
  if (epoch !== state.epoch) return;
  adoptListener(opened.listenerId);
  state.show = opened.show || {};
  state.episode = opened.episode || null;
  state.playback = opened.playback || null;
  state.statusShow = normalizeStatusShow(opened.status);
  $("stub-warning").hidden = !opened.status?.wireIsStubbed;
  enterEpisodeShell(state.show, {
    episode: state.episode,
    playback: state.playback,
    statusShow: state.statusShow,
  });
  if (!audioAllowed) {
    await showResumeGate("Tap Start listening to hear the episode.", state.audio, epoch, {
      primeWithSilence: true,
    });
    state.audio.pause();
  }
  attachRoomAnalyser();
  loadLibrary();
  if (epoch === state.epoch) showLoop(epoch);
}

async function openSavedEpisode(episodeId, from, button) {
  if (!episodeId || state.transitioning) return;
  const unlocked = unlockFromGesture();
  state.transitioning = true;
  $("studio").classList.add("transitioning");
  button.disabled = true;
  setLibraryOpen(false);
  const audioAllowed = await unlocked;
  const epoch = await endEpisode({ resetServer: false });
  try {
    const opened = await api(`episodes/${encodeURIComponent(episodeId)}/open`, {
      method: "POST",
      body: { from },
    });
    await activateOpenedEpisode(opened, audioAllowed, epoch);
  } catch (err) {
    if (epoch === state.epoch) {
      await enterWelcome();
      setLibraryOpen(true);
      toast(err.message);
    }
  } finally {
    button.disabled = false;
  }
}

function clearSharedUrl() {
  const url = new URL(location.href);
  url.searchParams.delete("episode");
  history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

async function showSharedPreview(shareId) {
  state.mode = "shared";
  state.sharedPreview = null;
  $("studio").classList.remove("welcome", "episode");
  $("studio").classList.add("shared");
  $("welcome-content").hidden = true;
  $("shared-content").hidden = false;
  $("shared-listen").disabled = true;
  $("shared-status").textContent = "Loading shared episode…";
  $("new-episode").hidden = true;
  $("share-current").hidden = true;
  $("new-podcast").hidden = true;
  $("toggle-profile").hidden = !state.listenerId;

  try {
    const preview = await api(`shared/${encodeURIComponent(shareId)}`, { withListener: false });
    if (state.mode !== "shared") return;
    state.sharedPreview = preview;
    $("shared-podcast").textContent = preview.podcast?.title || "Longtime Listener";
    $("shared-title").textContent = preview.episode?.episodeTitle || "Shared episode";
    $("shared-brief").textContent = preview.episode?.episodeBrief || preview.podcast?.brief || "";
    const parentTitle = preview.episode?.parentEpisodeTitle;
    $("shared-parent").hidden = !preview.episode?.isBranch && !preview.episode?.parentEpisodeId;
    $("shared-parent").textContent = parentTitle
      ? `A listener’s version of “${parentTitle}”`
      : "A listener’s version";
    $("shared-status").textContent = "";
    $("shared-listen").disabled = false;
  } catch (err) {
    if (state.mode !== "shared") return;
    $("shared-status").textContent = err.message;
  }
}

async function openSharedEpisode() {
  const shareId = state.sharedPreview?.shareId;
  if (!shareId || state.transitioning) return;
  const unlocked = unlockFromGesture();
  state.transitioning = true;
  $("studio").classList.add("transitioning");
  $("shared-listen").disabled = true;
  $("shared-status").textContent = "Opening the saved episode…";
  const audioAllowed = await unlocked;
  const epoch = await endEpisode({ resetServer: false });
  try {
    const opened = await api(`shared/${encodeURIComponent(shareId)}/open`, { method: "POST" });
    await activateOpenedEpisode(opened, audioAllowed, epoch);
  } catch (err) {
    if (epoch === state.epoch) {
      state.transitioning = false;
      $("studio").classList.remove("transitioning");
      $("shared-listen").disabled = false;
      $("shared-status").textContent = err.message;
    }
  }
}

/* ---------------- one-answer setup ---------------- */

function setSetupStatus(message = "") {
  $("setup-status").textContent = message;
}

function renderShowIdentity(show, episode = state.episode, playback = state.playback) {
  const seriesTitle = show?.title || show?.about || "Longtime Listener";
  const episodeTitle =
    show?.episodeTitle ||
    (show?.title ? "The first episode of " + show.title : "Your first episode");
  const brief =
    show?.episodeBrief ||
    show?.brief ||
    show?.episodeFocus ||
    show?.angle ||
    show?.episodes ||
    "A fresh conversation shaped around what you asked to hear.";

  $("show-title").textContent = seriesTitle;
  $("episode-title").textContent = episodeTitle;
  $("episode-brief").textContent = brief;
  const outline = Array.isArray(show?.episodeOutline)
    ? show.episodeOutline.filter((item) => typeof item === "string" && item.trim()).slice(0, 5)
    : [];
  const outlineEl = $("episode-outline");
  outlineEl.replaceChildren(
    ...outline.map((item) => Object.assign(document.createElement("li"), { textContent: item.trim() })),
  );
  $("episode-outline-wrap").hidden = !outline.length;

  const context = $("episode-context");
  if (playback?.shared) {
    context.textContent = episode?.parentEpisodeTitle
      ? `Shared · A listener’s version of “${episode.parentEpisodeTitle}”`
      : "Shared episode · Call in to create your own version";
    context.hidden = false;
  } else if (episode?.isBranch || episode?.parentEpisodeId) {
    context.textContent = episode.parentEpisodeTitle
      ? `Your version of “${episode.parentEpisodeTitle}”`
      : "Your version of an earlier episode";
    context.hidden = false;
  } else if (playback?.replay) {
    context.textContent = "Saved episode";
    context.hidden = false;
  } else {
    context.hidden = true;
    context.textContent = "";
  }
}

/** Unlock the shared audio element while a real tap is still on the stack. */
function unlockFromGesture() {
  if (setup.unlocked) return setup.unlocked;
  state.dismissResumeGate?.();
  state.audio.pause();
  state.audio.src = SILENCE;
  let started;
  try {
    started = state.audio.play();
  } catch {
    started = Promise.reject(new Error("audio blocked"));
  }
  const unlocked = Promise.resolve(started).then(
    () => true,
    () => false,
  );
  setup.unlocked = unlocked;
  // A refused attempt is not sticky. The next Call in or typed-submit tap is a
  // fresh browser gesture and gets its own chance to unlock playback.
  unlocked.then((allowed) => {
    if (!allowed && setup.unlocked === unlocked) setup.unlocked = null;
  });
  openAudioContext();
  return unlocked;
}

/**
 * Initial microphone tap. Permission and recorder setup happen first; the screen
 * says Ready only after MediaRecorder confirms it is capturing audio. There is no
 * host cue here, so nothing competes with or clips the listener's first words.
 */
async function beginSetupCall() {
  if (state.mode !== "welcome" || state.call.phase !== "idle" || state.transitioning) return;
  const token = ++callToken;
  const setupToken = ++setup.token;
  const unlocked = unlockFromGesture();
  setup.unlocked = unlocked;
  setup.phase = "preparing";
  state.call = { phase: "queued", token, bridgeId: null, sending: false };
  renderCall();
  setSetupStatus("");

  const stream = await prewarmMicrophone();
  if (!callAlive(token) || setupToken !== setup.token || state.mode !== "welcome") {
    releaseStream(stream);
    return;
  }

  const prepared = prepareRecorder(stream);
  if (!callAlive(token) || setupToken !== setup.token) {
    releaseStream(stream);
    return;
  }
  if (!prepared) {
    state.call.phase = "typed";
    setup.phase = "typing";
    renderCall();
    $("call-text").focus({ preventScroll: true });
    return;
  }

  await openMicrophone();
  if (callAlive(token) && state.call.phase === "live") setup.phase = "listening";
}

function showTypedSetup(typed = "") {
  if (state.mode !== "welcome" || state.call.phase !== "idle" || state.transitioning) return;
  setup.token += 1;
  const token = ++callToken;
  setup.phase = "typing";
  state.call = { phase: "typed", token, bridgeId: null, sending: false };
  $("call-text").value = typed;
  renderCall();
  if (!typed) $("call-text").focus({ preventScroll: true });
}

async function switchCallToTyping() {
  if (state.mode === "welcome") {
    if (!["queued", "inviting", "live"].includes(state.call.phase)) return;
    setup.token += 1;
    const token = ++callToken;
    await stopRecording();
    setup.phase = "typing";
    state.call = { phase: "typed", token, bridgeId: null, sending: false };
    setPaused(true);
    renderCall();
    $("call-text").focus({ preventScroll: true });
    return;
  }

  // During an episode, the server call is already on the board. Keep its token
  // and identity, close the live recorder fully, then expose the textarea.
  if (state.mode !== "episode" || state.call.phase !== "live") return;
  const token = state.call.token;
  state.call.phase = "switching";
  renderCall();
  await stopRecording();
  if (!callAlive(token) || state.mode !== "episode") return;
  state.call.phase = "typed";
  renderCall();
  $("call-text").focus({ preventScroll: true });
}

function appendSetupAnswer(heard) {
  const prior = document.getElementById("setup-answer-section");
  prior?.remove();
  const section = document.createElement("section");
  section.id = "setup-answer-section";
  section.className = "tsection";
  const header = document.createElement("header");
  const kicker = document.createElement("span");
  kicker.className = "kicker";
  kicker.textContent = "You called in";
  header.append(kicker);
  const lines = document.createElement("div");
  lines.className = "lines";
  const line = document.createElement("div");
  line.className = "line you said";
  line.dataset.speaker = "caller";
  const who = document.createElement("div");
  who.className = "who";
  who.textContent = "You";
  const text = document.createElement("p");
  text.className = "said-text";
  text.textContent = heard;
  line.append(who, text);
  lines.append(line);
  section.append(header, lines);
  $("transcript").append(section);
  scrollToLatest(line);
}

async function submitSetupAnswer({ blob, typed, token, unlocked }) {
  const setupToken = setup.token;
  let describeRequest;
  if (blob && blob.size > 800) {
    describeRequest = api("show/describe", {
      method: "POST",
      raw: blob,
      headers: { "content-type": blob.type || "audio/webm" },
    });
  } else if (typed) {
    describeRequest = api("show/describe", { method: "POST", body: { text: typed } });
  } else {
    throw new Error("Nothing came through — say it again, or type it.");
  }

  const described = await describeRequest;

  if (!callAlive(token) || setupToken !== setup.token || state.mode !== "welcome") return;
  setup.premise = described.premise;
  setup.researchId = described.researchId;
  setup.presetId = described.presetId ?? null;
  appendSetupAnswer(described.heard || typed);
  renderShowIdentity(described.premise);

  const defined = await api("show/define", {
    method: "POST",
    body: {
      ...(described.premise || {}),
      researchId: described.researchId ?? null,
      presetId: described.presetId ?? null,
    },
  });
  if (!callAlive(token) || setupToken !== setup.token || state.mode !== "welcome") return;
  await launch(defined, unlocked ?? setup.unlocked ?? Promise.resolve(false));
}

/** Everything from a defined series to its first generated line. */
async function launch(defined, unlocked) {
  const epoch = ++state.epoch;
  adoptListener(defined.listenerId);
  state.show = defined.show || {};
  setup.phase = "launching";

  await api("show/start", { method: "POST" });
  if (epoch !== state.epoch) return;
  const audioAllowed = await unlocked;
  if (epoch !== state.epoch) return;
  state.audio.pause();

  const status = await api("status").catch(() => null);
  if (epoch !== state.epoch) return;
  $("stub-warning").hidden = !status?.wireIsStubbed;
  state.statusShow = normalizeStatusShow(status);
  state.episode = state.statusShow?.episodeId
    ? {
        id: state.statusShow.episodeId,
        seriesId: state.statusShow.seriesId || state.show.seriesId,
        episodeTitle: state.show.episodeTitle,
        episodeBrief: state.show.episodeBrief,
      }
    : null;
  state.playback = { readOnly: false, replay: false, shared: false, from: "start" };
  enterEpisodeShell(state.show, {
    episode: state.episode,
    playback: state.playback,
    statusShow: state.statusShow,
  });
  state.call = { phase: "idle", token: ++callToken, bridgeId: null, sending: false };
  setup.phase = "idle";
  renderCall();

  if (!audioAllowed) {
    await showResumeGate("Tap Start listening to hear the episode.", state.audio, epoch, {
      primeWithSilence: true,
    });
    state.audio.pause();
  }
  attachRoomAnalyser();
  loadLibrary();
  if (epoch === state.epoch) showLoop(epoch);
}

function enterEpisodeShell(show, { episode = null, playback = null, statusShow = null } = {}) {
  state.mode = "episode";
  state.transitioning = false;
  state.show = show || state.show || {};
  state.episode = episode || state.episode;
  state.playback = playback || state.playback;
  state.statusShow = statusShow || state.statusShow;
  state.playbackComplete = false;
  renderShowIdentity(state.show, state.episode, state.playback);
  $("studio").classList.remove("welcome", "shared", "audio-blocked", "transitioning");
  $("studio").classList.add("episode");
  const setupAnswer = document.getElementById("setup-answer-section");
  $("welcome-content").hidden = true;
  $("shared-content").hidden = true;
  $("transcript").replaceChildren($("welcome-content"), $("shared-content"));
  if (setupAnswer) $("transcript").append(setupAnswer);
  state.sections.clear();
  state.follow = true;
  $("to-live").hidden = true;
  const ownsCurrentEpisode = !!currentEpisodeId() && !state.playback?.shared;
  $("new-episode").hidden = !ownsCurrentEpisode;
  $("share-current").hidden = !ownsCurrentEpisode;
  $("new-podcast").hidden = false;
  $("toggle-profile").hidden = !state.listenerId;
  $("pause").disabled = false;
  $("call-text").placeholder = "Type what you want to ask the hosts";
  setPaused(false);
  renderPauseLabel();
  renderCall();
}

async function startNewEpisode(event, selectedEpisodeId = currentEpisodeId()) {
  if (!state.listenerId || !selectedEpisodeId || state.transitioning) return;
  const button = event?.currentTarget || $("new-episode");
  const unlocked = unlockFromGesture();
  state.transitioning = true;
  $("studio").classList.add("transitioning");
  $("pause").disabled = true;
  $("new-podcast").hidden = false;
  setLibraryOpen(false);
  setSetupStatus("");
  renderCall();
  button.disabled = true;
  const oldLabel = button.textContent;
  button.textContent = "Creating…";
  // Let the gesture-started silence reach playing before teardown pauses and
  // clears the shared element. New podcast can still retire this transition.
  const beforeTransition = state.epoch;
  const audioAllowed = await unlocked;
  if (!state.transitioning || state.epoch !== beforeTransition) {
    button.disabled = false;
    button.textContent = oldLabel;
    return;
  }
  const epoch = await endEpisode({ resetServer: false });
  try {
    const result = await api(`episodes/${encodeURIComponent(selectedEpisodeId)}/new-episode`, {
      method: "POST",
    });
    if (epoch !== state.epoch) return;
    await activateOpenedEpisode(
      {
        ...result,
        playback: { from: "start", readOnly: false, replay: false, shared: false },
      },
      audioAllowed,
      epoch,
    );
  } catch (err) {
    if (epoch === state.epoch) {
      await enterWelcome();
      setLibraryOpen(true);
      toast(err.message);
    }
  } finally {
    button.disabled = false;
    button.textContent = oldLabel;
  }
}

async function endEpisode({ resetServer = true } = {}) {
  const epoch = ++state.epoch;
  setup.token += 1;
  state.cancelTurn?.();
  state.cancelTurn = null;
  // Stop the element before the first await. Cancelling settles playTurn, but the
  // media element itself otherwise keeps talking while call teardown runs.
  state.audio.pause();
  state.dismissResumeGate?.();
  setPaused(false);

  await hangUp({ silent: true });
  state.abort.abort();
  state.abort = new AbortController();

  state.audio.removeAttribute("src");
  state.linePlaying = false;
  state.prefetch.clear();
  markSpeaking(null);
  state.sections.clear();
  state.segment = null;
  state.jumpTo = null;
  state.skipSegmentId = null;
  state.playbackComplete = false;
  state.follow = true;
  $("to-live").hidden = true;

  if (resetServer && state.listenerId) {
    await api("show/reset", { method: "POST" }).catch(() => {});
  }
  return epoch;
}

async function enterWelcome() {
  state.mode = "welcome";
  state.transitioning = false;
  state.show = null;
  state.episode = null;
  state.playback = null;
  state.statusShow = null;
  state.sharedPreview = null;
  setup.phase = "idle";
  setup.unlocked = null;
  setup.premise = null;
  setup.researchId = null;
  setup.presetId = null;
  state.call = { phase: "idle", token: ++callToken, bridgeId: null, sending: false };
  state.awaitingAnswerId = null;
  state.audioBlocked = false;

  const welcome = $("welcome-content");
  const shared = $("shared-content");
  welcome.hidden = false;
  shared.hidden = true;
  $("transcript").replaceChildren(welcome, shared);
  document.getElementById("setup-answer-section")?.remove();
  setSetupStatus("");
  $("studio").classList.add("welcome");
  $("studio").classList.remove("episode", "shared", "paused", "audio-blocked", "transitioning");
  $("new-episode").hidden = true;
  $("share-current").hidden = true;
  $("new-podcast").hidden = true;
  $("pause").disabled = false;
  $("call-text").value = "";
  $("topic-text").value = "";
  $("topic-submit").disabled = true;
  $("call-text").placeholder = "What would you like this podcast to be about?";
  renderCall();
  renderPauseLabel();
  loadLibrary();
}

/* ---------------- wiring ---------------- */

$("pause").addEventListener("click", handlePause);
$("call-in").addEventListener("click", tapCallIn);
$("call-type").addEventListener("click", switchCallToTyping);
$("call-cancel").addEventListener("click", () => hangUp());
$("call-done").addEventListener("click", doneSpeaking);
$("call-text").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) doneSpeaking();
});
$("topic-text").addEventListener("input", () => {
  $("topic-submit").disabled = !$("topic-text").value.trim();
});
$("topic-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const typed = $("topic-text").value.trim();
  if (!typed) return;
  showTypedSetup(typed);
  doneSpeaking();
});

$("new-episode").addEventListener("click", startNewEpisode);
$("share-current").addEventListener("click", (event) =>
  shareEpisode(state.episode || { id: currentEpisodeId(), episodeTitle: state.show?.episodeTitle }, event.currentTarget),
);
$("new-podcast").addEventListener("click", async () => {
  const button = $("new-podcast");
  button.disabled = true;
  const epoch = await endEpisode({ resetServer: true });
  if (epoch === state.epoch) await enterWelcome();
  button.disabled = false;
});

$("open-library").addEventListener("click", () => setLibraryOpen($("library").hidden));
$("welcome-library").addEventListener("click", () => setLibraryOpen($("library").hidden));
$("close-library").addEventListener("click", () => setLibraryOpen(false));
$("copy-share-url").addEventListener("click", async () => {
  const url = $("share-url").value;
  try {
    await navigator.clipboard.writeText(url);
    toast("Share link copied.");
  } catch {
    $("share-url").focus();
    $("share-url").select();
    $("library-status").hidden = false;
    $("library-status").textContent = "Copy the selected link.";
  }
});
$("shared-listen").addEventListener("click", openSharedEpisode);
$("shared-home").addEventListener("click", async () => {
  const epoch = await endEpisode({ resetServer: false });
  clearSharedUrl();
  if (epoch === state.epoch) await enterWelcome();
});

$("toggle-profile").addEventListener("click", async () => {
  if (!state.listenerId) return;
  const panel = $("profile");
  const open = panel.hidden;
  panel.hidden = !open;
  $("toggle-profile").setAttribute("aria-expanded", String(open));
  if (open) {
    setLibraryOpen(false);
    await loadProfile().catch((err) => toast(err.message));
  }
});

$("close-profile").addEventListener("click", () => {
  $("profile").hidden = true;
  $("toggle-profile").setAttribute("aria-expanded", "false");
});

$("add-interest").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = $("interest-input");
  const label = input.value.trim();
  if (!label) return;
  input.value = "";
  await api("profile/interest", { method: "POST", body: { label } }).catch((err) => toast(err.message));
  loadProfile();
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (state.call.phase !== "idle") hangUp();
  else if (!$("profile").hidden) $("close-profile").click();
  else if (!$("library").hidden) setLibraryOpen(false);
});

$("toggle-profile").hidden = !state.listenerId;
renderPauseLabel();
if (requestedShareId) showSharedPreview(requestedShareId);
else loadLibrary();
