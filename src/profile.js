import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

// A listener profile is a small, editable model of what someone is interested in
// and how fast they want to be talked to.
//
// It is one profile across every podcast they set up, and interests in it are
// **scoped to the podcast they were learned on**. Calling in about the Eagles on a
// football show and then starting a show about history must not put the Eagles in
// the history show — the listener changed the subject, deliberately, by making a
// different podcast.
//
// The asymmetry is on purpose: promotion is scoped, suppression is not. What
// someone asked to hear more of belongs to the show they asked on; what they asked
// to hear less of, and how fast they want to be talked to, follow them everywhere,
// because both of those are only ever able to take something away.
//
// The rule that shapes everything here: **listening is not a signal.** A subject
// only enters this profile because the listener did something deliberate — asked
// about it, added it by hand, or told the hosts to go deeper on it. Learning every
// proper noun that appeared in a generated script is what put strangers in
// someone's profile, and it is not a thing this file does any more.
//
// Every entry therefore carries where it came from, and the interface says so.

const HALF_LIFE_DAYS = 21;
const dir = () => path.join(config.dataDir, "profiles");

/** Where an interest came from, and how to describe it to the listener. */
export const SOURCES = {
  caller: "you asked about this on air",
  manual: "you added this yourself",
  deeper: "you asked the hosts to go deeper on this",
  preference: "you told the hosts what you wanted",
  setup: "from the podcast you set up",
  legacy: "learned before we recorded why",
};

const empty = (id) => ({
  id,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  topics: {}, // label -> { score, updatedAt, pinned, source, scope }
  entities: {}, // name  -> { score, updatedAt, pinned, source, scope }
  // How fast this listener wants the hosts to move, -2..2. Driven only by the
  // hurry-up and dive-deeper controls.
  pacing: 0,
  log: [], // { at, action, title } — what the listener did, for the profile panel
  callIns: [], // { at, text, scope }
  covered: [], // topic keys actually aired for this listener
  muted: [], // labels the listener asked to hear less of
});

/** Lowercase, split the wire's `sports_recreation` / `deals.merger` into words. */
export function normalizeText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[_.]+/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Does `label` occur in `text` as a whole word or phrase? Freeform interests are
 * typed and spoken by people ("sports", "elon musk") while a wire labels things
 * as `sports_recreation`; an exact comparison never matches the two, so a stated
 * dislike would silently fail to change what gets picked.
 */
export function phraseMatches(label, text) {
  const l = normalizeText(label);
  const t = normalizeText(text);
  // No length floor: the boundaries below already prevent "AI" from matching
  // "said" or "maintain", and a floor would quietly drop AI, UK, US, EU, and
  // every other short interest someone actually types.
  if (!l || !t) return false;
  return t === l || t.startsWith(`${l} `) || t.endsWith(` ${l}`) || t.includes(` ${l} `);
}

const storyText = (story) =>
  [story.headline, ...(story.entities ?? []).map((e) => e.name)].join(" ");

/**
 * How strongly `label` describes `story`: an exact taxonomy hit outranks a word
 * inside a compound label, which outranks a mention in the headline or actors.
 */
export function labelWeight(label, story) {
  const taxonomy = [story.sector, story.eventType, (story.eventType || "").split(".")[0]].filter(Boolean);
  const wanted = normalizeText(label);
  if (!wanted) return 0;
  for (const t of taxonomy) if (normalizeText(t) === wanted) return 1;
  for (const t of taxonomy) if (phraseMatches(label, t)) return 0.8;
  if (phraseMatches(label, storyText(story))) return 0.5;
  return 0;
}

function decay(score, updatedAt) {
  const days = (Date.now() - new Date(updatedAt).getTime()) / 86400000;
  if (!Number.isFinite(days) || days <= 0) return score;
  return score * Math.pow(0.5, days / HALF_LIFE_DAYS);
}

function bump(bag, label, delta, source, scope) {
  if (!label) return;
  const key = String(label).trim();
  if (!key) return;
  const prev = bag[key];
  const base = prev ? decay(prev.score, prev.updatedAt) : 0;
  bag[key] = {
    score: Math.max(-6, Math.min(10, base + delta)),
    updatedAt: new Date().toISOString(),
    pinned: prev?.pinned ?? false,
    // A deliberate act always outranks whatever was there before, so an entry
    // that was once unattributable stops being unattributable the moment the
    // listener touches it again.
    source: source ?? prev?.source ?? "legacy",
    // Likewise the podcast: raising the same subject again on a different show
    // moves it to that show, because that is where the listener just raised it.
    scope: scope ?? prev?.scope ?? null,
  };
}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/**
 * Can this interest be explained to the listener? Anything the listener did on
 * purpose can; anything inherited from the version that learned by eavesdropping
 * cannot, unless they have since pinned it themselves.
 */
const isTrusted = (row) => (row.source ?? "legacy") !== "legacy" || !!row.pinned;

/**
 * May this interest steer the podcast currently on air? It has to be explainable
 * *and* belong to this show. An entry with no scope was learned before podcasts
 * were told apart, so it belongs to no particular one and steers none of them.
 */
const inScope = (row, scope) => isTrusted(row) && !!row.scope && row.scope === scope;

export class ProfileStore {
  constructor() {
    this.cache = new Map(); // id -> profile object (the single live copy)
    this.loading = new Map(); // id -> in-flight load, so two callers share one object
    this.chains = new Map(); // id -> tail of that listener's serialized mutations
  }

  #file(id) {
    return path.join(dir(), `${id}.json`);
  }

  /**
   * Single-flight: concurrent first loads for the same listener must resolve to the
   * *same* object, or two mutations racing on it each write a copy and one is lost.
   */
  async load(id) {
    const cached = this.cache.get(id);
    if (cached) return cached;
    const pending = this.loading.get(id);
    if (pending) return pending;

    const job = (async () => {
      let profile;
      try {
        profile = JSON.parse(await fs.readFile(this.#file(id), "utf8"));
      } catch {
        profile = empty(id);
      }
      profile = migrate({ ...empty(id), ...profile, id });
      // Another caller may have finished first while we were on the filesystem.
      const winner = this.cache.get(id) ?? profile;
      this.cache.set(id, winner);
      return winner;
    })().finally(() => this.loading.delete(id));

    this.loading.set(id, job);
    return job;
  }

  /**
   * All mutations for one listener run in series against the single cached object
   * and each one is flushed before the next begins, so an interleaved read-modify-
   * write cannot drop an update.
   */
  #mutate(id, fn) {
    const prev = this.chains.get(id) ?? Promise.resolve();
    const next = prev.then(async () => {
      const profile = await this.load(id);
      const result = await fn(profile);
      await this.#write(profile);
      return result ?? profile;
    });
    // Keep the chain alive even if one mutation rejects.
    this.chains.set(
      id,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  /**
   * The in-memory profile is already correct by the time this runs, so a failed
   * flush is logged and swallowed rather than rejected: losing a listener's
   * preferences to a full disk is bad, taking the episode off the air for it is
   * worse. The next successful write persists everything, since the whole object
   * is rewritten.
   */
  async #write(profile) {
    profile.updatedAt = new Date().toISOString();
    const file = this.#file(profile.id);
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      await fs.mkdir(dir(), { recursive: true });
      await fs.writeFile(tmp, JSON.stringify(profile, null, 2));
      await fs.rename(tmp, file); // atomic: a reader never sees a half-written profile
      this.lastWriteError = null;
    } catch (err) {
      this.lastWriteError = err.message;
      console.error(`[profile] could not persist ${profile.id}: ${err.message}`);
      await fs.rm(tmp, { force: true }).catch(() => {});
    }
  }

  /**
   * Current interest weights, decayed, sorted, and carrying their provenance.
   *
   * `include` selects which rows come back. The filter is applied *before* the
   * limit, deliberately: an old profile can hold a dozen high-scoring rows from
   * when everything the hosts said was learned, and ranking first would let them
   * fill the list and crowd out every interest the listener has actually stated.
   */
  interests(profile, { limit = 12, include = "all", scope = null } = {}) {
    const keep =
      include === "current"
        ? (row) => inScope(row, scope)
        : include === "other"
          ? (row) => !inScope(row, scope)
          : include === "trusted"
            ? (row) => isTrusted(row)
            : include === "legacy"
              ? (row) => !isTrusted(row)
              : () => true;
    const rank = (bag) =>
      Object.entries(bag)
        .map(([label, v]) => ({
          label,
          score: v.pinned ? Math.max(v.score, 3) : decay(v.score, v.updatedAt),
          pinned: !!v.pinned,
          source: v.source ?? "legacy",
          why: SOURCES[v.source ?? "legacy"],
          scope: v.scope ?? null,
        }))
        .filter((x) => Math.abs(x.score) > 0.15)
        .filter(keep)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    return {
      topics: rank(profile.topics),
      entities: rank(profile.entities),
      muted: profile.muted ?? [],
      pacing: profile.pacing ?? 0,
    };
  }

  /**
   * How well a story matches this listener, roughly -6..+10.
   *
   * An interest with no explanation behind it never *promotes* anything. The panel
   * tells the listener those rows no longer steer the show, and this is where that
   * has to be true — a positive legacy score changing what gets picked would make
   * that statement false. Negative ones still count: "I do not want this" is worth
   * honouring whatever version of the app recorded it.
   */
  affinity(profile, story, { scope = null } = {}) {
    const { topics, entities, muted } = this.interests(profile, { limit: 100 });
    // Promotion belongs to the podcast it was learned on. Suppression does not:
    // "less sports" is worth honouring wherever it was said, and it can only ever
    // push something down.
    const steers = (row) => inScope(row, scope) || row.score < 0;
    let score = 0;

    // Each label contributes once, at its best match strength — so "sports" reaches
    // a `sports_recreation` story without triple-counting sector, type and family.
    for (const topic of topics) {
      if (!steers(topic)) continue;
      const weight = labelWeight(topic.label, story);
      if (weight) score += topic.score * weight;
    }

    for (const interest of entities) {
      if (!steers(interest)) continue;
      const named = (story.entities ?? []).find(
        (e) => normalizeText(e.name) === normalizeText(interest.label),
      );
      if (named) score += interest.score * (named.salience ?? 0.5);
      else if (phraseMatches(interest.label, storyText(story))) score += interest.score * 0.5;
    }

    // A mute is a hard veto, and it has to catch the freeform spelling too.
    for (const label of muted) {
      if (labelWeight(label, story) > 0) {
        score -= 8;
        break;
      }
    }
    return score;
  }

  /**
   * The hurry-up / dive-deeper control. Pacing is the point of both: how long the
   * hosts spend, not whether the listener likes the people in the segment.
   *
   * "Deeper" additionally raises the subject, because asking for more of a thing
   * is a real statement about that thing. "Hurry" raises nothing and lowers
   * nothing — it would otherwise teach the profile to dislike whoever happened to
   * be named in a segment that ran long.
   */
  recordPace(id, { action, title = null, topics = [], scope = null }) {
    return this.#mutate(id, (profile) => {
      // Pacing is global: it is about how the listener wants to be talked to, and
      // that does not change because the subject did.
      const step = action === "deeper" ? 1 : -1;
      profile.pacing = clamp((profile.pacing ?? 0) + step, -2, 2);
      profile.log.unshift({ at: new Date().toISOString(), action, title, scope });
      profile.log = profile.log.slice(0, 100);
      if (action === "deeper") {
        for (const label of topics.filter(Boolean)) bump(profile.topics, label, 1.2, "deeper", scope);
      }
      return profile;
    });
  }

  /**
   * Log the call itself. Called the moment the question is accepted, not when the
   * hosts finish answering — asking is the signal, and the answer can still fail.
   */
  recordCallIn(id, { text, scope = null }) {
    return this.#mutate(id, (profile) => {
      profile.callIns.unshift({ at: new Date().toISOString(), text, scope });
      profile.callIns = profile.callIns.slice(0, 100);
    });
  }

  /**
   * Apply interest weights for something the listener did deliberately. `source`
   * is required and ends up in front of them in the profile panel, so there is no
   * way to add an unattributable interest through this path.
   */
  applyInterests(id, { labels = [], entities = [], source, scope = null, topicWeight = 1.1, entityWeight = 1.4 }) {
    // Rejected, not thrown: every caller of this is a detached task that handles
    // failure with `.catch`, and a synchronous throw would skip past all of them.
    if (!source) {
      return Promise.reject(
        new Error("applyInterests needs a source: interests must be explainable"),
      );
    }
    if (!labels.length && !entities.length) return this.load(id);
    return this.#mutate(id, (profile) => {
      for (const label of labels) bump(profile.topics, label, topicWeight, source, scope);
      for (const e of entities) bump(profile.entities, e, entityWeight, source, scope);
    });
  }

  /**
   * A stated preference about coverage. "less X" has to move the weight *down* and
   * mute the label — the mistake it guards against is hearing "less sports" and
   * learning an interest in sports because the word was mentioned.
   */
  setPreference(id, label, direction, { scope = null } = {}) {
    const clean = String(label ?? "").trim();
    if (!clean) return this.load(id);
    return this.#mutate(id, (profile) => {
      if (direction === "less") {
        // Unscoped: a mute follows the listener to every podcast, because it can
        // only ever take something away.
        bump(profile.topics, clean, -3, "preference", null);
        if (!profile.muted.includes(clean)) profile.muted.push(clean);
      } else {
        // Scoped: "more of the technical stuff" is about this show.
        bump(profile.topics, clean, 3, "preference", scope);
        profile.muted = profile.muted.filter((m) => m !== clean);
        if (profile.topics[clean]) profile.topics[clean].pinned = true;
      }
    });
  }

  /** Call this when a subject has actually been on air, not when it was planned. */
  markCovered(id, keys) {
    const ids = (Array.isArray(keys) ? keys : [keys]).filter(Boolean);
    if (!ids.length) return this.load(id);
    return this.#mutate(id, (profile) => {
      for (const key of ids) if (!profile.covered.includes(key)) profile.covered.push(key);
      profile.covered = profile.covered.slice(-400);
    });
  }

  setInterest(id, { kind = "topic", label, score, pinned, remove, source = "manual", scope = null }) {
    return this.#mutate(id, (profile) => {
      const bag = kind === "entity" ? profile.entities : profile.topics;
      if (remove) {
        delete bag[label];
        profile.muted = profile.muted.filter((m) => m !== label);
      } else {
        bag[label] = {
          score: score ?? Math.max(3, bag[label]?.score ?? 0),
          updatedAt: new Date().toISOString(),
          pinned: pinned ?? true,
          source,
          // Typed into the panel of whichever podcast was on air, which is the
          // podcast the listener meant it for.
          scope,
        };
        profile.muted = profile.muted.filter((m) => m !== label);
      }
    });
  }

  setMuted(id, label, muted) {
    return this.#mutate(id, (profile) => {
      profile.muted = profile.muted.filter((m) => m !== label);
      if (muted) profile.muted.push(label);
    });
  }

  /** Reset the pacing dial without touching anything else. */
  setPacing(id, pacing) {
    return this.#mutate(id, (profile) => {
      profile.pacing = clamp(Number(pacing) || 0, -2, 2);
    });
  }

  /**
   * One line the script prompts can use.
   *
   * Interests learned before provenance was recorded are deliberately left out:
   * they are the ones that were picked up from passive listening, and steering a
   * live episode with them is exactly the behaviour being fixed.
   */
  brief(profile, { scope = null } = {}) {
    // In-scope rows are selected before the limit, not after: filtering afterwards
    // lets a handful of high-scoring rows from another podcast take all eight slots
    // and leave this show's actual stated interests out of the prompt entirely.
    const { topics, entities } = this.interests(profile, { limit: 8, include: "current", scope });
    const { muted } = this.interests(profile, { limit: 100 });
    const negatives = this.interests(profile, { limit: 100 }).topics.filter((t) => t.score < 0);
    const parts = [];
    const likes = topics.filter((t) => t.score > 0).map((t) => t.label);
    const names = entities.filter((t) => t.score > 0).map((t) => t.label);
    if (likes.length) parts.push(`has asked for ${likes.join(", ")}`);
    if (names.length) parts.push(`follows ${names.join(", ")}`);
    const dislikes = negatives.map((t) => t.label);
    if (dislikes.length || muted.length)
      parts.push(`has asked for less ${[...new Set([...dislikes, ...muted])].join(", ")}`);
    // The last call on *this* podcast. Quoting a question someone asked on a
    // different show is the same leak as the interests above, one line down.
    const recentCall = (profile.callIns ?? []).find((c) => c.scope && c.scope === scope);
    if (recentCall) parts.push(`last called in about: "${recentCall.text.slice(0, 140)}"`);
    return parts.length ? parts.join("; ") : "no history yet — this is a first listen";
  }
}

/**
 * Bring a profile written by an earlier version forward without losing anything.
 *
 * The interests are kept — they are the listener's data — but they are stamped
 * `legacy`, because the old code could not distinguish "you asked about this"
 * from "this name appeared in a script you happened to hear". The interface shows
 * them separately and `brief()` does not steer the episode with them.
 */
function migrate(profile) {
  for (const bag of [profile.topics, profile.entities]) {
    for (const entry of Object.values(bag)) {
      if (!entry || entry.source) continue;
      // `pinned` was only ever set by the listener adding or asking for something
      // by hand, so those entries have a provenance after all — keep them as the
      // deliberate choices they were rather than sweeping them in with the rest.
      entry.source = entry.pinned ? "manual" : "legacy";
    }
  }
  if (typeof profile.pacing !== "number") profile.pacing = 0;
  // Entries written before podcasts were told apart belong to no particular one,
  // so they steer none of them. The panel shows them and the listener can keep
  // them; raising the same subject again on any show adopts it there.
  for (const bag of [profile.topics, profile.entities]) {
    for (const entry of Object.values(bag)) {
      if (entry && entry.scope === undefined) entry.scope = null;
    }
  }
  if (!Array.isArray(profile.log)) profile.log = [];
  // The old thumbs log becomes history in the same list, so nothing is dropped
  // from what the listener can see.
  if (Array.isArray(profile.feedback) && profile.feedback.length && !profile.log.length) {
    profile.log = profile.feedback.slice(0, 100).map((f) => ({
      at: f.at,
      action: f.verdict === "up" ? "liked" : "disliked",
      title: f.headline ?? null,
      legacy: true,
    }));
  }
  delete profile.feedback;
  return profile;
}

export const profiles = new ProfileStore();
