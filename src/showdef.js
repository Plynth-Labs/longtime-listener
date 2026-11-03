import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

/**
 * What podcast this is. The listener answers three questions before anything is
 * generated, and every prompt in the app is built from the answers:
 *
 *   about    — what the podcast is about
 *   episodes — what each episode should cover
 *   angle    — what makes this one different from anything else on the subject
 *
 * The news is one preset among several, not the product. `families` picks the
 * publication allow-list the research is held to, `useWire` decides whether the
 * metered news wire is consulted at all, and `freshness` is how hard the search
 * leans on recency — a football show wants this week, a history show does not.
 */

const dir = () => path.join(config.dataDir, "shows");

export const PRESETS = [
  {
    id: "news",
    name: "The Front Page",
    blurb: "The day's biggest stories, the ones the national desks are actually leading with.",
    about: "the most consequential news in the world right now",
    episodes:
      "the handful of stories a well-informed American should not have missed today, with " +
      "enough background on each to understand why it matters",
    angle:
      "no filler and no false balance — big stories only, told plainly, with the hosts saying " +
      "outright when the reporting is thin or still moving",
    episodeOutline: [
      "The biggest consequential story and what materially changed",
      "The next development with the widest real-world stakes",
      "An undercovered story that changes the larger picture",
      "What is still unresolved and worth watching next",
    ],
    families: ["news"],
    freshness: "the last 48 hours",
    useWire: true,
  },
  {
    id: "nfl",
    name: "NFL Football",
    blurb: "The league week: games, injuries, contracts, and who is actually good.",
    about: "the NFL",
    episodes:
      "what happened in the league this week — the games that turned, the injuries that " +
      "change a season, the roster and contract moves worth knowing about",
    angle:
      "arguments backed by what actually happened on the field, not hot takes; the hosts say " +
      "when a narrative is not supported by the tape or the numbers",
    episodeOutline: [
      "The game or decision that changed the shape of the week",
      "The roster, injury, or contract consequence behind it",
      "What the evidence says about the strongest league-wide argument",
      "The next matchup or decision that could overturn that read",
    ],
    families: ["sports"],
    // A week, because a week is a round of games.
    freshness: "the last 7 days",
    wireMaxAgeHours: 168,
    useWire: false,
  },
  {
    id: "tech",
    name: "Tech and AI",
    blurb: "What shipped, what broke, and what it means — past the press release.",
    about: "technology and artificial intelligence",
    episodes:
      "the releases, research, and business moves that changed something this week, and the " +
      "mechanism underneath them",
    angle:
      "explains how the thing actually works before arguing about it, and is willing to say " +
      "when a launch is a rebrand",
    episodeOutline: [
      "The release or research result that changed something concrete",
      "How the underlying technology actually works",
      "Who gains, who bears the cost, and where the claims outrun the evidence",
      "What would make this development matter over the longer term",
    ],
    families: ["tech", "science"],
    // News-shaped: last week's launch is not this episode's story.
    freshness: "the last 48 hours",
    useWire: false,
  },
  {
    id: "space",
    name: "Space and Astronomy",
    blurb: "Missions in flight, discoveries landing, and the physics behind them.",
    about: "spaceflight and astronomy",
    episodes:
      "one mission or discovery worked through properly, plus what else is currently flying " +
      "or about to launch",
    angle:
      "takes the engineering seriously — orbits, instruments, power budgets — and treats the " +
      "listener as someone who wants to understand it, not just be impressed by it",
    episodeOutline: [
      "The mission or discovery and the question it is trying to answer",
      "The engineering or physics that makes the work possible",
      "What the evidence can establish and what remains uncertain",
      "The next milestone that could change the picture",
    ],
    families: ["science", "reference"],
    freshness: null,
    useWire: false,
  },
  {
    id: "history",
    name: "History, Properly Told",
    blurb: "One episode, one thread — how something actually came to be.",
    about: "history",
    episodes:
      "a single event, person, or invention followed from cause to consequence, with the " +
      "parts that usually get skipped",
    angle:
      "no myth-repeating — the hosts say where the record is contested and where the famous " +
      "version of the story is not what happened",
    episodeOutline: [
      "The conditions that made the central event possible",
      "The decisions and people that changed its course",
      "The evidence behind the familiar version and where it is contested",
      "The consequences that lasted after the event ended",
    ],
    families: ["reference"],
    freshness: null,
    useWire: false,
  },
  {
    id: "markets",
    name: "Business and Markets",
    blurb: "What moved, who is exposed, and what the numbers actually say.",
    about: "business, markets, and the economy",
    episodes:
      "the moves that mattered — earnings, rates, deals, and the data releases underneath " +
      "them — with the second-order effects spelled out",
    angle:
      "numbers first and no ticker-chasing; the hosts say when a move is noise and when a " +
      "story has no good data behind it yet",
    episodeOutline: [
      "The move with the clearest economic consequence",
      "The numbers and mechanism underneath that move",
      "Who is exposed if the prevailing interpretation is wrong",
      "The next data or decision that could change the outlook",
    ],
    families: ["news", "tech"],
    freshness: "the last 48 hours",
    useWire: true,
  },
];

/**
 * Subject classification. Matching is token-aware, never substring: "explains"
 * contains "ai", "start" contains "art", and "plainly" contains "plain" — a
 * substring test hands a show about eighteenth-century clockmaking to the AI desk
 * and a history show a seven-day recency window.
 */
const FAMILY_HINTS = [
  // Deliberately without "world" and "war": "the ancient world" and "the war of
  // the roses" are history, and matching them here sent a podcast about Roman
  // aqueducts to the wire services with a forty-eight-hour window.
  [["news", "headlines", "current affairs", "politics", "election", "elections", "geopolitics", "congress", "parliament", "diplomacy", "foreign policy"], "news"],
  [["sport", "sports", "football", "nfl", "nba", "mlb", "baseball", "soccer", "basketball", "hockey", "olympics", "tennis", "golf", "league", "playoffs", "premier league", "formula one"], "sports"],
  [["tech", "technology", "software", "ai", "artificial intelligence", "machine learning", "startup", "startups", "computing", "internet", "robotics", "robots", "chips", "semiconductors", "programming", "cybersecurity"], "tech"],
  [["science", "space", "spaceflight", "astronomy", "physics", "biology", "chemistry", "climate", "medicine", "health", "nasa", "research", "neuroscience", "oceans", "geology", "genetics", "ecology"], "science"],
  [["history", "historical", "ancient", "medieval", "victorian", "renaissance", "biography", "archaeology", "culture", "art", "architecture", "music", "film", "cinema", "literature", "mythology", "philosophy", "engineering history"], "reference"],
];

/** Words that mean "tell me what is happening now", rather than "explain a thing". */
const CURRENCY_WORDS = [
  "news", "headlines", "latest", "today", "this week", "current", "currently",
  "right now", "breaking", "happening", "recent", "recently", "daily", "weekly",
  "up to date", "what's going on", "whats going on", "this season", "this month",
];

const tokenize = (text) =>
  String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);

/**
 * A hint matches when it is a whole token in the text, or — for multi-word hints —
 * a whole phrase bounded by spaces.
 */
function hintMatches(hint, tokens, padded) {
  if (hint.includes(" ")) return padded.includes(` ${hint} `);
  return tokens.includes(hint);
}

export function inferFamilies(text) {
  const tokens = tokenize(text);
  const padded = ` ${tokens.join(" ")} `;
  const found = [];
  for (const [words, family] of FAMILY_HINTS) {
    if (words.some((w) => hintMatches(w, tokens, padded)) && !found.includes(family)) {
      found.push(family);
    }
  }
  return found;
}

/** Is this a show about what is happening, or a show about how something works? */
export function isCurrentAffairs(text, families = []) {
  const tokens = tokenize(text);
  const padded = ` ${tokens.join(" ")} `;
  if (CURRENCY_WORDS.some((w) => hintMatches(w, tokens, padded))) return true;
  return families.includes("news");
}

/**
 * Which podcast an interest belongs to.
 *
 * Derived from the subject rather than from an identifier, so setting the same
 * podcast up again next week is the same podcast and keeps what it learned, while
 * a different subject is a different show however it was created. The subject is
 * the only field that decides this: rewriting the angle of a show about the NFL
 * leaves it a show about the NFL.
 */
export function showScope(definition) {
  const subject = String(definition?.about ?? "")
    .toLowerCase()
    .replace(/^(the|a|an)\s+/, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!subject) return "sc_none";
  return "sc_" + crypto.createHash("sha1").update(subject).digest("hex").slice(0, 16);
}

/**
 * A standalone research subject for the first item of an episode. Generated focus
 * copy can be perfectly intelligible beside the series card while becoming vague
 * when sent alone to search ("how they knew where they were"). Always anchor it
 * to the series subject; harmless repetition is preferable to missing identity.
 */
export function episodeResearchSubject(definition) {
  const about = clean(definition?.about, 400);
  const focus = clean(definition?.episodeFocus, 240);
  if (!focus) return about;
  if (!about) return focus;
  return `${about}: ${focus}`.slice(0, 640);
}

const clean = (value, max) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** Keep a spoken roadmap label intact instead of ending on half a word. */
function cleanOutlineBeat(value, max = 140) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  const candidate = normalized.slice(0, max - 1).trimEnd();
  const boundary = candidate.lastIndexOf(" ");
  // A model-produced beat should contain several words. If malformed input is one
  // enormous token, a neutral bounded label is more useful than a mangled token.
  if (boundary < 1) return "Episode beat…";
  return `${candidate.slice(0, boundary).replace(/[,:;\-–—]+$/g, "").trimEnd()}…`;
}

/**
 * Keep the episode roadmap small enough to say out loud and concrete enough to
 * steer research. Older saved shows have no outline, so the fallback supplies a
 * useful four-beat shape without changing their identity.
 */
export function normalizeEpisodeOutline(value, { about = "", episodeFocus = "" } = {}) {
  const anchor = clean(episodeFocus, 140) || clean(about, 140) || "the episode subject";
  const fallback = [
    `The essential context behind ${anchor}`,
    `How ${anchor} works or unfolded in practice`,
    `The strongest evidence and disagreement around ${anchor}`,
    `What ${anchor} changes or leaves unresolved`,
  ];
  const supplied = Array.isArray(value) ? value.filter((beat) => typeof beat === "string") : [];
  const candidates = [...supplied];
  const outline = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const beat = cleanOutlineBeat(candidate);
    const key = beat.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
    if (!beat || !key || seen.has(key)) continue;
    seen.add(key);
    outline.push(beat);
    if (outline.length === 5) break;
  }
  if (outline.length >= 3) return outline;

  const target = outline.length ? 3 : 4;
  for (const candidate of fallback) {
    const beat = cleanOutlineBeat(candidate);
    const key = beat.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
    if (!beat || !key || seen.has(key)) continue;
    seen.add(key);
    outline.push(beat);
    if (outline.length === target) break;
  }
  return outline;
}

/**
 * The durable outline is also the initial running order. Research receives the
 * full series subject, episode facet, and one beat together, so a poetic screen
 * label cannot lose the identity of what it is meant to investigate.
 */
export function episodeOutlinePlan(definition) {
  const about = clean(definition?.about, 160);
  const focus = clean(definition?.episodeFocus, 180) || about;
  const outline = normalizeEpisodeOutline(definition?.episodeOutline, {
    about,
    episodeFocus: focus,
  });
  return outline.map((beat, index) => {
    const parts = [about, focus !== about ? focus : "", beat].filter(Boolean);
    const subject = parts.join(": ").slice(0, 640);
    return {
      title: beat,
      query: subject,
      subject,
      why: index === 0
        ? clean(definition?.episodeBrief, 300) || "the first promised beat of this episode"
        : `the next promised beat in the episode's roadmap`,
      outlineBeat: beat,
    };
  });
}

/** The exact first beat used to prime and later claim setup-time research. */
export function firstEpisodeResearchSubject(definition) {
  return episodeOutlinePlan(definition)[0]?.subject || episodeResearchSubject(definition);
}

/**
 * Build a validated show definition from what the listener typed. A preset is a
 * set of defaults for the same three fields, so an edited preset and a from-scratch
 * show are the same object by the time anything downstream sees it.
 */
export function defineShow({
  presetId,
  about,
  episodes,
  angle,
  title,
  brief,
  episodeTitle,
  episodeBrief,
  episodeFocus,
  episodeOutline,
  episodeNumber,
  episodeHistory,
  createdAt,
  episodeCreatedAt,
} = {}) {
  const preset = PRESETS.find((p) => p.id === presetId) ?? null;

  const definition = {
    presetId: preset?.id ?? "custom",
    presetName: preset?.name ?? null,
    about: clean(about, 400) || preset?.about || "",
    episodes: clean(episodes, 400) || preset?.episodes || "",
    angle: clean(angle, 400) || preset?.angle || "",
  };
  if (!definition.about) {
    const err = new Error("Say what the podcast is about — that is the one thing we cannot guess.");
    err.status = 400;
    throw err;
  }
  if (!definition.episodes) definition.episodes = `whatever is most worth knowing about ${definition.about}`;
  if (!definition.angle) definition.angle = "direct, specific, and honest about what is not known";

  // Only the subject fields re-classify a preset. The angle is about *how* the
  // hosts talk, not what they talk about — rewriting it on the Markets preset
  // should not throw away its curated list of financial desks.
  const edited =
    preset && (definition.about !== preset.about || definition.episodes !== preset.episodes);

  // An edited preset is re-classified from what the listener actually wrote: the
  // "News" preset rewritten into a show about Formula One should not keep
  // searching wire services and nothing else.
  if (preset && !edited) {
    definition.families = preset.families;
    definition.freshness = preset.freshness;
    definition.wireMaxAgeHours = preset.wireMaxAgeHours ?? 72;
    definition.useWire = preset.useWire;
  } else {
    // The subject decides. What one episode covers and how the hosts treat it can
    // add a family the subject did not name, but they can never add *news* — a
    // generated episode shape that happened to say "the ancient world" is not
    // evidence that this is a news podcast, and reading it as one is what put a
    // show about Roman aqueducts on a forty-eight-hour news window.
    const subject = definition.about;
    // Only what the listener actually wrote for *this* subject widens the
    // classification. A preset's own wording, left in place as a default after the
    // subject was changed out from under it, is not theirs — and the news preset's
    // "…should not have missed today" was enough to classify a podcast about
    // competitive bread baking as current affairs and spend a wire call on it.
    const authored = (value, fallback) => (preset && value === fallback ? "" : value);
    const widened = [
      definition.about,
      authored(definition.episodes, preset?.episodes),
      authored(definition.angle, preset?.angle),
    ]
      .filter(Boolean)
      .join(" ");
    const fromSubject = inferFamilies(subject);
    const extra = inferFamilies(widened).filter((f) => f !== "news");
    let families = fromSubject.length ? fromSubject : extra;

    // Recency is applied only to a show that is actually about what is happening.
    // A history podcast asked for "the last 7 days" comes back with nothing, or
    // worse, with this week's press releases about the Renaissance. Either the
    // listener said something current in their own words, or the subject itself is
    // the news; an inferred family is not enough.
    const current = isCurrentAffairs(widened, fromSubject);
    // A show about what is happening now, with no subject of its own, is the news.
    if (current && !families.length) families = ["news"];

    definition.families = families;
    definition.freshness = !current
      ? null
      : families.includes("sports")
        ? "the last 7 days"
        : "the last 48 hours";
    definition.wireMaxAgeHours = definition.freshness === "the last 7 days" ? 168 : 72;
    // The metered wire is only worth a call for a show that is genuinely about
    // the news; everything else is served better and more cheaply by search.
    definition.useWire = current && families[0] === "news";
  }

  // The generated names are part of the product, rather than transient display
  // copy. Keep them with the definition so a restart cannot silently rename the
  // podcast or the episode currently on air.
  definition.title = clean(title, 80) || (preset && !edited ? preset.name : titleFor(definition.about));
  definition.brief = clean(brief, 280) ||
    (preset && !edited ? preset.blurb : `A focused podcast about ${definition.about}.`);
  definition.episodeTitle = clean(episodeTitle, 100) || `Inside ${titleFor(definition.about)}`;
  definition.episodeBrief = clean(episodeBrief, 320) ||
    `A close look at ${definition.about}, following the most revealing thread.`;
  definition.episodeFocus = clean(episodeFocus, 240) || definition.about;
  definition.episodeOutline = normalizeEpisodeOutline(
    episodeOutline ?? (preset && !edited ? preset.episodeOutline : null),
    { about: definition.about, episodeFocus: definition.episodeFocus },
  );
  definition.episodeNumber = Math.max(1, Math.min(9999, Number.parseInt(episodeNumber, 10) || 1));
  definition.episodeHistory = cleanEpisodeHistory(episodeHistory);

  const scope = showScope(definition);
  definition.seriesId = scope.replace(/^sc_/, "series_");
  definition.episodeId = episodeIdentity(definition);
  const now = new Date().toISOString();
  definition.createdAt = validDate(createdAt) || now;
  definition.episodeCreatedAt = validDate(episodeCreatedAt) || now;
  return definition;
}

/** A short display name for a listener-written show. */
function titleFor(about) {
  const words = about.replace(/^(the|a|an)\s+/i, "").split(/\s+/).slice(0, 6).join(" ");
  return words.replace(/^./, (c) => c.toUpperCase());
}

function validDate(value) {
  if (typeof value !== "string" || !value.trim() || Number.isNaN(Date.parse(value))) return null;
  return value.trim().slice(0, 40);
}

function cleanEpisodeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      episodeId: clean(item.episodeId, 48),
      episodeNumber: Math.max(1, Math.min(9999, Number.parseInt(item.episodeNumber, 10) || 1)),
      episodeTitle: clean(item.episodeTitle, 100),
      episodeBrief: clean(item.episodeBrief, 320),
      episodeFocus: clean(item.episodeFocus, 240),
    }))
    .filter((item) => item.episodeFocus)
    .slice(-12);
}

function episodeIdentity(definition) {
  const input = [definition.seriesId || showScope(definition), definition.episodeNumber, definition.episodeFocus]
    .join("\n")
    .toLowerCase();
  return "episode_" + crypto.createHash("sha1").update(input).digest("hex").slice(0, 18);
}

/**
 * Move a saved podcast to a new episode without allowing the generation step to
 * rename or reclassify the series. Pure so the persistence boundary can be tested
 * without starting a model or touching a listener's saved show.
 */
export function nextEpisodeDefinition(series, generated = {}) {
  const current = defineShow(series);
  const prior = {
    episodeId: current.episodeId,
    episodeNumber: current.episodeNumber,
    episodeTitle: current.episodeTitle,
    episodeBrief: current.episodeBrief,
    episodeFocus: current.episodeFocus,
  };
  const previousFocuses = new Set(
    [...current.episodeHistory, prior].map((item) => item.episodeFocus.toLowerCase()),
  );
  let focus = clean(generated.episodeFocus, 240);
  if (!focus || previousFocuses.has(focus.toLowerCase())) {
    focus = `a different narrow facet of ${current.about}`;
  }

  return defineShow({
    ...current,
    // These are the only fields an episode generator owns.
    episodeId: null,
    episodeNumber: current.episodeNumber + 1,
    episodeTitle: clean(generated.episodeTitle, 100) || `Another Side of ${current.title}`,
    episodeBrief: clean(generated.episodeBrief, 320) || `A new facet of ${current.about}.`,
    episodeFocus: focus,
    episodeOutline: normalizeEpisodeOutline(generated.episodeOutline, {
      about: current.about,
      episodeFocus: focus,
    }),
    episodeHistory: [...current.episodeHistory, prior],
    episodeCreatedAt: null,
  });
}

class ShowDefStore {
  constructor() {
    this.cache = new Map();
    this.writes = new Map();
  }

  #file(id) {
    return path.join(dir(), `${id}.json`);
  }

  async load(id) {
    if (this.cache.has(id)) return this.cache.get(id);
    try {
      const parsed = defineShow(JSON.parse(await fs.readFile(this.#file(id), "utf8")));
      this.cache.set(id, parsed);
      return parsed;
    } catch {
      return null;
    }
  }

  async save(id, definition) {
    this.cache.set(id, definition);
    const file = this.#file(id);
    const previous = this.writes.get(id) ?? Promise.resolve();
    const job = previous.catch(() => {}).then(async () => {
      const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
      try {
        await fs.mkdir(dir(), { recursive: true });
        await fs.writeFile(tmp, JSON.stringify(definition, null, 2));
        await fs.rename(tmp, file);
      } catch (err) {
        // The live definition is already in memory and the episode can run on it;
        // losing the file costs the listener a re-setup next visit, not this one.
        console.error(`[show] could not persist definition for ${id}: ${err.message}`);
        await fs.rm(tmp, { force: true }).catch(() => {});
      }
    });
    this.writes.set(id, job);
    await job;
    if (this.writes.get(id) === job) this.writes.delete(id);
    return definition;
  }
}

export const showDefs = new ShowDefStore();
