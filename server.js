import crypto from "node:crypto";
import path from "node:path";
import express from "express";
import { assertKeys, config, DEFAULT_NEWSMCP_URL } from "./src/config.js";
import { newsmcp } from "./src/newsmcp.js";
import { profiles, SOURCES } from "./src/profile.js";
import { defineShow, firstEpisodeResearchSubject, PRESETS, showDefs } from "./src/showdef.js";
import { derivePremise } from "./src/llm.js";
import { primeResearch } from "./src/research.js";
import { promptAudio, promptView, SETUP_PROMPTS, warmSetupPrompts } from "./src/setupprompts.js";
import { speak, transcribe } from "./src/tts.js";
import { allShows, showFor, warmBridges } from "./src/show.js";
import { cachedPath } from "./src/tts.js";
import { episodes } from "./src/episodes.js";

assertKeys();

const app = express();
const api = express.Router();

app.set("etag", false);
app.use(express.json({ limit: "1mb" }));

function listenerOf(req) {
  const id = req.get("x-listener-id") || req.query.listener || req.body?.listenerId;
  if (typeof id === "string" && /^[a-zA-Z0-9_-]{6,64}$/.test(id)) return id;
  return null;
}

function requireListener(req, res) {
  const id = listenerOf(req);
  if (!id) {
    res.status(400).json({ error: "missing or malformed listener id" });
    return null;
  }
  return id;
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

/* ---------------- setting up a podcast ---------------- */

// The suggestions on the setup screen. Each one is a set of defaults for the same
// three questions, so a preset the listener edits and a show they wrote from
// scratch are the same object by the time the hosts see it.
api.get("/presets", (req, res) => {
  res.json({
    presets: PRESETS.map((p) => ({
      id: p.id,
      name: p.name,
      blurb: p.blurb,
      about: p.about,
      episodes: p.episodes,
      angle: p.angle,
    })),
  });
});

api.get(
  "/show",
  wrap(async (req, res) => {
    const listenerId = listenerOf(req);
    if (!listenerId) return res.json({ show: null });
    res.json({ show: await showDefs.load(listenerId) });
  }),
);

api.post(
  "/show/define",
  wrap(async (req, res) => {
    const listenerId = listenerOf(req) ?? `l_${crypto.randomBytes(8).toString("hex")}`;
    const definition = defineShow(req.body ?? {});
    const show = showFor(listenerId);
    // The head start, if this podcast is the one it was taken for. Anything else
    // arriving with someone else's id gets nothing: the id is the ownership.
    const researchId = typeof req.body?.researchId === "string" ? req.body.researchId : null;
    const saved = await show.define(definition, { researchId });
    res.json({ listenerId, show: saved });
  }),
);

// The questions the hosts ask out loud between the listener's answers, and the
// matching text for the screen.
api.get("/setup/prompts", (req, res) => {
  res.json({ prompts: Object.keys(SETUP_PROMPTS).map((key) => promptView(key)) });
});

api.get(
  "/setup/prompt/:key/audio",
  wrap(async (req, res) => {
    const file = await promptAudio(req.params.key);
    if (!file) return res.status(404).json({ error: "unknown prompt" });
    res.type("audio/mpeg");
    res.setHeader("cache-control", "public, max-age=86400, immutable");
    res.sendFile(path.resolve(file), { dotfiles: "allow" });
  }),
);

// Speech to text, on its own. The second and third setup questions need nothing
// but the words: the premise was already worked out from the first answer.
api.post(
  "/transcribe",
  express.raw({ type: ["audio/*", "video/webm", "application/octet-stream"], limit: "25mb" }),
  wrap(async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      return res.status(400).json({ error: "no audio was uploaded" });
    }
    const text = (await transcribe(req.body, req.get("content-type") || "audio/webm"))
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 600);
    res.json({ text });
  }),
);

/**
 * The front door: they are asked what their podcast is about and they say it out
 * loud. The recording arrives here, is transcribed, and is split into the three
 * things a show needs.
 *
 * Deliberately side-effect free — it reads and returns, and `/show/define` is what
 * writes. Transcription plus the split takes a few seconds, and someone who gives
 * up on a slow recording and types their answer instead would otherwise have the
 * abandoned one land afterwards and overwrite the podcast they actually asked for.
 * The client holds the token that decides which answer counts.
 *
 * Also accepts `{"text": "..."}`, which is the typing fallback for someone who
 * cannot talk right now, and how the test drivers set a show up.
 */
api.post(
  "/show/describe",
  express.raw({ type: ["audio/*", "video/webm", "application/octet-stream"], limit: "25mb" }),
  wrap(async (req, res) => {
    // Tapping a suggestion is an answer to the first question, not a way past all
    // three: the listener still gets asked their angle and what an episode covers,
    // with the preset's own wording waiting behind Skip. It also means a suggestion
    // starts the research at the same moment a spoken answer would.
    const requestedPreset = Buffer.isBuffer(req.body) ? req.query.presetId : req.body?.presetId;
    const preset = PRESETS.find((p) => p.id === requestedPreset);

    let heard = "";
    if (preset) {
      heard = preset.about;
    } else if (Buffer.isBuffer(req.body) && req.body.length) {
      heard = await transcribe(req.body, req.get("content-type") || "audio/webm");
    } else if (typeof req.body?.text === "string") {
      heard = req.body.text;
    }
    heard = heard.trim().replace(/\s+/g, " ").slice(0, 1200);
    if (heard.length < 2) {
      return res.status(400).json({
        error: "We didn't catch that — say what the podcast is about, or type it instead.",
        code: "NOTHING_HEARD",
      });
    }

    // A preset's wording is already written; re-deriving it would only let it drift.
    const generatedPremise = preset
      ? (() => {
          const made = defineShow({ presetId: preset.id });
          return {
            about: made.about,
            episodes: made.episodes,
            angle: made.angle,
            title: made.title,
            brief: made.brief,
            episodeTitle: made.episodeTitle,
            episodeBrief: made.episodeBrief,
            episodeFocus: made.episodeFocus,
            episodeOutline: made.episodeOutline,
          };
        })()
      : await derivePremise({ spoken: heard });
    // Validated here so a premise that cannot become a show fails on the screen
    // that asked the question, rather than one request later.
    // Classify the head start under the exact preset rules that /show/define will
    // later save. Omitting the id makes curated multi-family/freshness presets look
    // custom here, so their otherwise valid research is rejected on claim.
    const provisional = defineShow({ ...generatedPremise, presetId: preset?.id });
    const premise = {
      about: provisional.about,
      episodes: provisional.episodes,
      angle: provisional.angle,
      title: provisional.title,
      brief: provisional.brief,
      episodeTitle: provisional.episodeTitle,
      episodeBrief: provisional.episodeBrief,
      episodeFocus: provisional.episodeFocus,
      episodeOutline: provisional.episodeOutline,
    };

    // The subject is known now, and the listener still has two questions to answer.
    // Start looking into it rather than waiting for them to finish — this is the
    // head start that stops the hosts going to air ahead of their own research.
    //
    // Researched from what they actually said, not from the episode shape the
    // model invented around it. "Ancient history — start with Roman aqueducts"
    // names a starting point, and searching a generated summary of it instead
    // throws that away and asks about the ancient world in general.
    //
    // The id is minted here rather than keyed on the listener, who does not exist
    // yet: they are created when the setup finishes. Keying on them meant a first
    // visitor — the only person the setup conversation is for — never got a head
    // start at all.
    const researchId = `rid_${crypto.randomBytes(9).toString("hex")}`;
    const researchSubject = firstEpisodeResearchSubject(provisional);
    primeResearch({
      researchId,
      query: researchSubject,
      subject: researchSubject,
      show: provisional,
    });

    res.json({
      heard,
      premise,
      researchId,
      presetId: preset?.id ?? null,
    });
  }),
);

api.post(
  "/show/start",
  wrap(async (req, res) => {
    const listenerId = requireListener(req, res);
    if (!listenerId) return;
    const show = showFor(listenerId);
    if (!(await show.definition())) {
      return res.status(409).json({ error: "no podcast set up for this listener", code: "NO_SHOW" });
    }
    show.start().catch((err) => console.error("[show] start failed:", err.message));
    res.json({ listenerId, status: show.status() });
  }),
);

// Tear the current episode down without starting another. The client calls this
// on its way back to the setup screen: whatever was queued belongs to an episode
// that is over, and leaving it running means the old show plays on behind the
// premise being rewritten.
api.post(
  "/show/reset",
  wrap(async (req, res) => {
    const listenerId = requireListener(req, res);
    if (!listenerId) return;
    await showFor(listenerId).archiveAndReset();
    res.json({ ok: true });
  }),
);

/* ---------------- saved episodes ---------------- */

api.get(
  "/episodes",
  wrap(async (req, res) => {
    const listenerId = requireListener(req, res);
    if (!listenerId) return;
    res.json({ podcasts: await episodes.podcasts(listenerId) });
  }),
);

api.post(
  "/episodes/:id/open",
  wrap(async (req, res) => {
    const listenerId = requireListener(req, res);
    if (!listenerId) return;
    const record = await episodes.load(listenerId, req.params.id);
    if (!record) return res.status(404).json({ error: "saved episode not found", code: "EPISODE_NOT_FOUND" });
    await episodes.assertPlayable(record);
    const from = req.body?.from === "resume" ? "resume" : "start";
    const show = showFor(listenerId);
    await show.openArchive(record, { from });
    res.json({
      listenerId,
      show: record.definition,
      episode: episodes.metadata(record),
      playback: { from, readOnly: true, replay: true, shared: false },
      status: show.status(),
    });
  }),
);

api.post(
  "/episodes/:id/share",
  wrap(async (req, res) => {
    const listenerId = requireListener(req, res);
    if (!listenerId) return;
    let record = await episodes.load(listenerId, req.params.id);
    if (!record) return res.status(404).json({ error: "saved episode not found", code: "EPISODE_NOT_FOUND" });
    const show = showFor(listenerId);
    if (show.archiveEpisodeId === req.params.id) await show.flushArchive();
    record = await episodes.load(listenerId, req.params.id);
    await episodes.assertPlayable(record);
    const shared = await episodes.share(listenerId, req.params.id);
    res.json({
      shareId: shared.shareId,
      url: `?episode=${encodeURIComponent(shared.shareId)}`,
      episode: episodes.metadata({ ...shared.record, shareId: shared.shareId }),
    });
  }),
);

api.get(
  "/shared/:shareId",
  wrap(async (req, res) => {
    const shared = await episodes.loadShared(req.params.shareId);
    if (!shared) return res.status(404).json({ error: "shared episode not found", code: "SHARE_NOT_FOUND" });
    const def = shared.episode.definition;
    res.json({
      shareId: shared.shareId,
      podcast: { seriesId: def.seriesId, title: def.title, brief: def.brief, about: def.about },
      episode: episodes.metadata({ ...shared.episode, shareId: shared.shareId }),
    });
  }),
);

api.post(
  "/shared/:shareId/open",
  wrap(async (req, res) => {
    const shared = await episodes.loadShared(req.params.shareId);
    if (!shared) return res.status(404).json({ error: "shared episode not found", code: "SHARE_NOT_FOUND" });
    await episodes.assertPlayable(shared.episode);
    const listenerId = listenerOf(req) ?? `l_${crypto.randomBytes(12).toString("hex")}`;
    const show = showFor(listenerId);
    await show.openArchive(shared.episode, { from: "start", shared: true, shareId: shared.shareId });
    res.json({
      listenerId,
      show: shared.episode.definition,
      episode: episodes.metadata({ ...shared.episode, shareId: shared.shareId }),
      playback: { from: "start", readOnly: true, replay: true, shared: true },
      status: show.status(),
    });
  }),
);

api.post(
  "/episodes/:id/new-episode",
  wrap(async (req, res) => {
    const listenerId = requireListener(req, res);
    if (!listenerId) return;
    const record = await episodes.load(listenerId, req.params.id);
    if (!record) return res.status(404).json({ error: "saved episode not found", code: "EPISODE_NOT_FOUND" });
    const show = showFor(listenerId);
    await show.openArchive(record, { from: "resume" });
    const definition = await show.newEpisode();
    const saved = await episodes.load(listenerId, show.archiveEpisodeId);
    res.json({
      ok: true,
      listenerId,
      show: definition,
      episode: saved ? episodes.metadata(saved) : null,
      status: show.status(),
    });
  }),
);

// Start a fresh episode of the same podcast. Everything queued for the old one is
// voided rather than deferred.
api.post(
  "/show/new-episode",
  wrap(async (req, res) => {
    const listenerId = requireListener(req, res);
    if (!listenerId) return;
    const show = showFor(listenerId);
    if (!(await show.definition())) {
      return res.status(409).json({ error: "no podcast set up for this listener", code: "NO_SHOW" });
    }
    const definition = await show.newEpisode();
    res.json({ ok: true, status: show.status(), show: definition });
  }),
);

/* ---------------- playback ---------------- */

api.get(
  ["/next", "/replay/next"],
  wrap(async (req, res) => {
    const listenerId = requireListener(req, res);
    if (!listenerId) return;
    const show = showFor(listenerId);
    if (show.replay) res.setHeader("x-newscast-replay", "1");
    // The public gateway exempts this route from generation quotas.
    if (req.path === "/replay/next" && !show.replay) {
      return res.status(409).json({ error: "Open a saved episode first.", code: "NOT_REPLAYING" });
    }
    const requestedWait = Number(req.query.wait ?? 30000);
    const timeoutMs = Number.isFinite(requestedWait)
      ? Math.max(0, Math.min(30000, requestedWait))
      : 30000;
    const next = await show.next({ timeoutMs });
    if (!next && show.playbackComplete()) {
      return res.json({ episodeEnded: true, replay: true, episodeId: show.archiveEpisodeId });
    }
    if (!next) return res.status(204).end();
    // `resumeFrom` is where playback should pick up. Earlier turns are still sent so
    // a reloaded client can render the transcript it missed.
    res.json({ ...next.segment.view(0), resumeFrom: next.resumeFrom });
  }),
);

api.get(
  "/segment/:id",
  wrap(async (req, res) => {
    const listenerId = requireListener(req, res);
    if (!listenerId) return;
    const show = showFor(listenerId);
    const segment = show.segment(req.params.id);
    if (!segment) return res.status(404).json({ error: "unknown segment" });
    const from = Math.max(0, Number(req.query.from ?? 0) || 0);
    if (req.query.wait !== "0") await segment.waitForTurn(from, 25000);
    res.json(segment.view(from));
  }),
);

api.get(
  "/audio/:segmentId/:turnIndex",
  wrap(async (req, res) => {
    const listenerId = requireListener(req, res);
    if (!listenerId) return;
    const show = showFor(listenerId);
    const segment = show.segment(req.params.segmentId);
    if (!segment) return res.status(404).json({ error: "unknown segment" });
    const index = Number(req.params.turnIndex);
    await segment.waitForTurn(index, 25000);
    const turn = segment.turns[index];
    if (!turn) return res.status(404).json({ error: "unknown turn" });
    let file;
    if (segment.archived) {
      file = await cachedPath(turn.audio);
      if (!file) {
        const err = new Error("The original audio for this saved turn is unavailable.");
        err.status = 410;
        err.code = "ARCHIVE_AUDIO_MISSING";
        throw err;
      }
    } else {
      const host = config.hosts[turn.speaker] ?? config.hosts.ari;
      file = await speak({ text: turn.text, voice: host.voice, instructions: host.delivery });
    }
    res.type("audio/mpeg");
    // Private: this is one listener's episode, including the answer to their call.
    res.setHeader("cache-control", "private, max-age=86400, immutable");
    // The data directory may sit under a hidden directory; only this
    // server-generated cache file is served, so a dotted ancestor must not 404.
    res.sendFile(path.resolve(file), { dotfiles: "allow" });
  }),
);

api.post(
  "/progress",
  wrap(async (req, res) => {
    const listenerId = requireListener(req, res);
    if (!listenerId) return;
    // `finished` is the default so an older client (and the test drivers) keep the
    // previous meaning: a reported turn is a heard turn.
    const phase = ["started", "finished", "skipped"].includes(req.body.phase)
      ? req.body.phase
      : "finished";
    await showFor(listenerId).reportProgress({
      segmentId: req.body.segmentId,
      turnIndex: Number(req.body.turnIndex ?? 0),
      phase,
      heardSeconds: Number(req.body.heardSeconds ?? 0),
    });
    res.json({ ok: true, phase });
  }),
);

/* ---------------- pacing ---------------- */

// "Hurry up" and "dive deeper". Both are about how much time the hosts spend, not
// about whether the listener likes the subject — see ProfileStore.recordPace.
api.post(
  "/pace",
  wrap(async (req, res) => {
    const listenerId = requireListener(req, res);
    if (!listenerId) return;
    const { segmentId, action } = req.body ?? {};
    if (!["hurry", "deeper"].includes(action)) {
      return res.status(400).json({ error: "action must be 'hurry' or 'deeper'" });
    }
    const show = showFor(listenerId);
    const result = action === "hurry" ? await show.hurry(segmentId) : await show.deeper(segmentId);
    if (!result) return res.status(404).json({ error: "nothing on air to change" });
    res.json({ ok: true, action, ...result });
  }),
);

/* ---------------- call-in ---------------- */

// Tap: the board lights up. Nothing on air changes yet — the hosts keep talking
// while the browser's microphone prompt is still in front of the listener.
api.post(
  "/call/start",
  wrap(async (req, res) => {
    const listenerId = requireListener(req, res);
    if (!listenerId) return;
    res.json(showFor(listenerId).queueCall());
  }),
);

// The recorder is prepared. Only now do the hosts hand over, so the invitation can
// never air ahead of something able to catch the first word of the reply.
api.post(
  "/call/invite",
  wrap(async (req, res) => {
    const listenerId = requireListener(req, res);
    if (!listenerId) return;
    const result = showFor(listenerId).inviteCaller();
    if (!result) return res.status(409).json({ error: "no call is waiting on the board" });
    res.json(result);
  }),
);

// The invitation finished and the recorder is actually running.
api.post(
  "/call/live",
  wrap(async (req, res) => {
    const listenerId = requireListener(req, res);
    if (!listenerId) return;
    res.json({ call: showFor(listenerId).markCallLive() });
  }),
);

api.post(
  "/call/cancel",
  wrap(async (req, res) => {
    const listenerId = requireListener(req, res);
    if (!listenerId) return;
    const reason = typeof req.body?.reason === "string" ? req.body.reason.slice(0, 80) : "hung up";
    res.json(showFor(listenerId).cancelCall({ reason }) ?? { call: null, jumpTo: null });
  }),
);

/**
 * "Done speaking" lands here with the recording itself. There is no confirm-the-text
 * step: the listener spoke, so the transcription goes to the hosts, and it is shown
 * in the transcript afterwards as what was heard.
 *
 * Also accepts `{"question": "..."}` as JSON, which is how the typed fallback and
 * the test drivers submit.
 */
api.post(
  "/call/submit",
  express.raw({ type: ["audio/*", "video/webm", "application/octet-stream"], limit: "25mb" }),
  wrap(async (req, res) => {
    const listenerId = requireListener(req, res);
    if (!listenerId) return;
    const show = showFor(listenerId);

    let question = "";
    if (Buffer.isBuffer(req.body) && req.body.length) {
      question = await transcribe(req.body, req.get("content-type") || "audio/webm");
    } else if (typeof req.body?.question === "string") {
      question = req.body.question.trim();
    }
    question = question.trim().slice(0, 600);
    if (!question) {
      return res.status(400).json({ error: "no question — nothing was said and no text was sent" });
    }

    const result = await show.submitCall({ question });
    res.json({
      question,
      callId: result.call.id,
      jumpTo: result.jumpTo,
      // Where the caller's own words are printed: the hosts' reaction to the
      // question, which starts before the answer to it exists.
      coverSegmentId: result.coverSegmentId,
      answerSegmentId: result.answerSegmentId,
      episodeId: result.episodeId,
      forked: result.forked,
    });
  }),
);

/* ---------------- profile ---------------- */

api.get(
  "/profile",
  wrap(async (req, res) => {
    const listenerId = requireListener(req, res);
    if (!listenerId) return;
    const profile = await profiles.load(listenerId);
    // Which podcast is on air. Everything the listener sees is split against it,
    // because that is the split that decides what steers this episode.
    const show = showFor(listenerId);
    await show.definition();
    const scope = show.scope;
    res.json({
      id: profile.id,
      brief: profiles.brief(profile, { scope }),
      // Two lists, each limited on its own. Ranking them together and splitting
      // afterwards lets a long-standing pile of rows from other podcasts fill the
      // panel and hide the interests belonging to this one.
      interests: profiles.interests(profile, { include: "current", scope }),
      elsewhere: profiles.interests(profile, { include: "other", scope }),
      pacing: profile.pacing,
      // Why an interest is there, in the listener's words, so the panel can say it.
      provenance: SOURCES,
      log: profile.log.slice(0, 20),
      callIns: profile.callIns.slice(0, 20),
      coveredCount: profile.covered.length,
      updatedAt: profile.updatedAt,
    });
  }),
);

api.post(
  "/profile/interest",
  wrap(async (req, res) => {
    const listenerId = requireListener(req, res);
    if (!listenerId) return;
    const { label, kind, remove, score } = req.body ?? {};
    if (typeof label !== "string" || !label.trim()) {
      return res.status(400).json({ error: "label is required" });
    }
    const show = showFor(listenerId);
    await show.definition();
    const profile = await profiles.setInterest(listenerId, {
      label: label.trim().slice(0, 60),
      kind: kind === "entity" ? "entity" : "topic",
      remove: !!remove,
      score: typeof score === "number" ? score : undefined,
      source: "manual",
      // Typed into the panel of the podcast that is on air, which is the podcast
      // the listener meant it for.
      scope: show.scope,
    });
    res.json({ interests: profiles.interests(profile, { include: "current", scope: show.scope }) });
  }),
);

api.post(
  "/profile/mute",
  wrap(async (req, res) => {
    const listenerId = requireListener(req, res);
    if (!listenerId) return;
    const { label, muted } = req.body ?? {};
    if (typeof label !== "string" || !label.trim()) {
      return res.status(400).json({ error: "label is required" });
    }
    const profile = await profiles.setMuted(listenerId, label.trim(), muted !== false);
    res.json({ interests: profiles.interests(profile) });
  }),
);

api.post(
  "/profile/pacing",
  wrap(async (req, res) => {
    const listenerId = requireListener(req, res);
    if (!listenerId) return;
    const profile = await profiles.setPacing(listenerId, req.body?.pacing);
    res.json({ pacing: profile.pacing });
  }),
);

api.get(
  "/status",
  wrap(async (req, res) => {
    const listenerId = listenerOf(req);
    res.json({
      ok: true,
      model: config.anthropic.model,
      researchModel: config.openai.researchModel,
      // True only when NEWSMCP_URL has been pointed somewhere else — the stub used
      // for interface work serves invented stories, and the page says so out loud.
      wireIsStubbed: config.newsmcp.url !== DEFAULT_NEWSMCP_URL,
      voices: {
        ari: config.hosts.ari.voice,
        dev: config.hosts.dev.voice,
        producer: config.hosts.producer.voice,
      },
      newsmcp: newsmcp.status(),
      shows: allShows().length,
      show: listenerId ? showFor(listenerId).status() : null,
    });
  }),
);

api.use((err, req, res, _next) => {
  console.error("[api]", err.stack || err.message);
  const status = err.status ?? (err.code === "BUDGET_EXHAUSTED" ? 503 : 500);
  res.status(status).json({ error: err.message, code: err.code ?? null });
});

const base = process.env.BASE_PATH ? `/${process.env.BASE_PATH.replace(/^\/|\/$/g, "")}` : "";
app.use(`${base}/api`, api);
app.use(base || "/", express.static(path.join(config.root, "public"), { extensions: ["html"] }));

const server = app.listen(config.port, config.host, async () => {
  console.log(`newscast listening on http://${config.host}:${config.port}${base}/`);
  try {
    const limits = await newsmcp.checkLimits();
    console.log(`[newsmcp] ${limits.remaining}/${limits.hourly} calls left this hour ` +
      `(${limits.reserve} reserved for call-ins)`);
  } catch (err) {
    console.warn(`[newsmcp] limit check failed: ${err.message}`);
  }
  Promise.all([warmBridges(), warmSetupPrompts()])
    .then(() => console.log("[tts] call-in bridges and setup questions pre-rendered"))
    .catch((err) => console.warn(`[tts] warmup failed: ${err.message}`));
});

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Flush immediately: long polls may delay the close callback for 30 seconds.
    const flushing = Promise.allSettled(allShows().map((show) => show.flushArchive()));
    server.close(async () => {
      await flushing;
      await Promise.allSettled(allShows().map((show) => show.flushArchive()));
      process.exit(0);
    });
    setTimeout(() => process.exit(1), Math.max(35000, config.timeouts.tts + 5000)).unref();
  });
}
