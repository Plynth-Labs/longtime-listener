import { config } from "./config.js";
import { fetchWithTimeout, readBody, withDeadline } from "./http.js";
import { newsmcp, screenStories } from "./newsmcp.js";
import { domainsFor, hostOf, outletName } from "./outlets.js";
import { wikiLookup } from "./wikipedia.js";

/**
 * Research for one thing the hosts are about to talk about — a planned topic or a
 * question a caller just asked. Three sources run in parallel behind one deadline:
 *
 *   web search  — takes the topic or the question as written, resolves pronouns
 *                 against whatever was on air, and is restricted to the show's
 *                 allowed domains so the hosts cannot end up sourcing a content
 *                 farm. Primary, and always run.
 *   Wikipedia   — background and durable fact, via plaintext extracts. Free, fast,
 *                 and the reason a show about the Apollo programme has something to
 *                 say that this week's news does not.
 *   NewsMCP     — only for shows that are actually about the news, and only when
 *                 the subject is named and the shared hourly budget can spare it.
 *
 * Every segment gets its own round. Nothing here is pre-fetched once and re-read
 * for the rest of the episode.
 */

const STOPWORDS = new Set(
  ("a an the and or but what whats what's why how who when where is are was were do does did can could " +
    "would should will about tell me us more on of for to in it that this they them their there here " +
    "please talk say know think going happened happening hey guys hi hello you your i im i'm we we're " +
    "any some latest news story stories thing things really just like get got " +
    // Short function words. The content-word filter below keeps three-letter words
    // — "sea", "war", "NFL" are subjects — so these have to be named rather than
    // dropped by length.
    "its his her our not all into from with been were than then over also such " +
    "very most much many out off per via who did does was are has had one two")
    .split(/\s+/),
);

/** Strip the inline `([domain](url))` citation markers so nothing reads them aloud. */
export function stripInlineCitations(text) {
  return text
    .replace(/\(\s*\[[^\]]*\]\([^)]*\)\s*(?:,\s*\[[^\]]*\]\([^)]*\)\s*)*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([.,;:])/g, "$1")
    .trim();
}

function today() {
  return new Date().toLocaleDateString("en-US", {
    timeZone: config.openai.timezone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/**
 * Ask the web, restricted to the show's publications.
 *
 * `filters.allowed_domains` is the whole reason this path runs on the 5-series
 * model — the 4.1 family rejects the field with a 400, and losing it silently
 * removes the only guarantee that the reporting came from somewhere real.
 */
export async function webResearch({
  query,
  context = "",
  domains = [],
  freshness = null,
  timeoutMs = 18000,
  signal,
  researchAngle = "",
}) {
  const search = { type: "web_search" };
  if (domains.length) search.filters = { allowed_domains: domains };
  search.user_location = {
    type: "approximate",
    country: config.openai.country,
    timezone: config.openai.timezone,
  };

  const input = [
    `Today is ${today()}.`,
    context ? `Context — this is what the podcast hosts were talking about: ${context}` : null,
    `Research this for the hosts: ${query}`,
    researchAngle ? `Your independent desk assignment: ${researchAngle}` : null,
    freshness
      ? `Prioritise reporting from ${freshness}. Lead with what is consequential and widely covered, not with whatever is merely recent.`
      : "This is not a current-events question. Do not imply anything is recent, new, or " +
        "breaking unless a source says so and gives a date — a durable fact with no date " +
        "attached is what is wanted here.",
    "Search now and report the concrete facts: what happened or what is true, the dates,",
    "the numbers, and who is saying it. Name the publication for anything contested.",
    "Say plainly if the reporting is thin, disputed, or has moved on.",
    "Eight sentences at most. Do not address anyone and do not write dialogue — this is a",
    "research note for the hosts, not a script.",
  ]
    .filter(Boolean)
    .join("\n");

  const res = await fetchWithTimeout(
    `${config.openai.baseUrl}/responses`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.openai.apiKey}`,
        "content-type": "application/json",
      },
      signal,
      body: JSON.stringify({
        model: config.openai.researchModel,
        reasoning: { effort: config.openai.researchEffort },
        tools: [search],
        // Required, every time. The failure this prevents is the model answering
        // a caller from its own memory of last week while the show claims to have
        // just looked it up.
        tool_choice: "required",
        max_output_tokens: 2000,
        input,
      }),
    },
    timeoutMs,
  );

  if (!res.ok) {
    const detail = await readBody(res, "text").catch(() => "");
    throw new Error(`Web research ${res.status}: ${detail.slice(0, 300)}`);
  }
  const json = await readBody(res, "json");
  const message = (json.output ?? []).find((o) => o.type === "message");
  const part = (message?.content ?? []).find((c) => c.type === "output_text");
  const raw = part?.text ?? "";
  if (!raw.trim()) return null;

  const seen = new Set();
  const sources = [];
  for (const a of part.annotations ?? []) {
    if (a.type !== "url_citation" || !a.url) continue;
    const url = a.url.replace(/[?&]utm_source=openai\b/, "");
    const host = hostOf(url);
    if (!host || seen.has(host)) continue;
    seen.add(host);
    sources.push({ url, host, name: outletName(url) ?? host, title: a.title ?? host, kind: "web" });
  }
  return { summary: stripInlineCitations(raw), sources: sources.slice(0, 8) };
}

/**
 * Turn a spoken question into NewsMCP arguments. Names go in `subject` (it phrase-
 * quotes them and widens the window to 30 days); otherwise one keyword in `q`,
 * because bare space-separated words are ANDed and a three-word `q` returns nothing.
 * Returns null when the question does not name anything worth spending a call on.
 */
export function queryForQuestion(question) {
  // Characters the query grammar rejects outright. They become commas rather than
  // spaces so "Tesla/SpaceX" reads as two names instead of one unmatchable phrase.
  const cleaned = question.replace(/[[\]/\\:^]+/g, ", ").trim();
  if (!cleaned) return null;

  const properNoun = /\b([A-Z][\w.'-]+(?:\s+(?:of|de|and)?\s*[A-Z][\w.'-]+){0,3})\b/g;
  const candidates = [];
  let m;
  while ((m = properNoun.exec(cleaned)) !== null) {
    const phrase = m[1].trim();
    const first = phrase.split(/\s+/)[0].toLowerCase();
    // The first word of a sentence is capitalised whether or not it is a name.
    if (m.index === 0 && !phrase.includes(" ") && STOPWORDS.has(first)) continue;
    if (STOPWORDS.has(phrase.toLowerCase())) continue;
    candidates.push(phrase);
  }
  const subject = candidates.sort((a, b) => b.length - a.length)[0];
  if (subject) return { subject, from_: "7 days ago" };

  const words = cleaned
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 4 && !STOPWORDS.has(w));
  if (words.length < 1) return null;
  // Only worth a metered call when the question actually names a subject; a single
  // generic keyword is what the web search already covers for free.
  if (!/[A-Z]/.test(cleaned.slice(1))) return null;
  return { q: words.sort((a, b) => b.length - a.length)[0], from_: "7 days ago" };
}

/**
 * The wire, for a caller who named a subject. The results go through exactly the
 * same outlet-and-scale screen as the episode planner's: a subject search is not a
 * side door around the floor that keeps a single-outlet local story off the air.
 */
export async function newsResearch({ question, maxAgeHours = 72 }) {
  const args = queryForQuestion(question);
  if (!args) return [];
  const result = await newsmcp.news(
    { ...args, limit: 8 },
    { priority: "essential", ttlMs: config.newsmcp.searchTtlMs, cacheKey: `call:${JSON.stringify(args)}` },
  );
  return screenStories(result.events ?? [], { maxAgeHours, limit: 4 });
}

function wikiSources(pages) {
  return pages.map((p) => ({
    url: p.url,
    host: "en.wikipedia.org",
    name: "Wikipedia",
    title: p.title,
    kind: "reference",
  }));
}

/** The publisher links behind the wire stories, so a caller can follow them too. */
function wireSources(stories) {
  const out = [];
  for (const story of stories) {
    for (const url of story.sources ?? []) {
      const host = hostOf(url);
      if (!host) continue;
      out.push({ url, host, name: outletName(url) ?? host, title: story.headline, kind: "wire" });
    }
  }
  return out;
}

/**
 * Crude singular/plural fold, so "aqueducts" finds "Roman aqueduct".
 *
 * Only a trailing "s" comes off. Stripping "es" wholesale folded "whales" to
 * "whal" while "whale" stayed whole, so the two stopped matching each other —
 * which is the opposite of the job.
 */
function stem(word) {
  if (word.endsWith("ies") && word.length > 4) return `${word.slice(0, -3)}y`;
  if (word.endsWith("ss")) return word;
  if (word.endsWith("s") && word.length > 3) return word.slice(0, -1);
  return word;
}

function contentWords(text) {
  return new Set(
    String(text ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, " ")
      .split(/\s+/)
      // Three letters, not four: "the deep sea" loses its subject at a length-four
      // floor, and so does any show about war, art, oil, or the NFL.
      .filter((w) => w.length > 2 && !STOPWORDS.has(w))
      .map(stem),
  );
}

/**
 * Is this article *about* the subject, or does it merely share a word with it?
 *
 * Wikipedia ranks on the whole query, so a spoken question comes back with
 * whatever shares its commonest word — "how did Roman aqueducts move water uphill"
 * returned Roman funerary practices, and a longer question returned Glasgow. Both
 * mention something in the query; neither is the article that was wanted.
 *
 * The discriminator is what the *title* adds. "Roman aqueduct" introduces nothing
 * the subject did not already name, so it is the article. "Roman funerary
 * practices" introduces two whole ideas of its own, so it is a different subject
 * that happens to share a word.
 */
export function wikiIsRelevant(page, subject) {
  const wanted = contentWords(subject);
  if (!wanted.size) return true; // nothing distinctive to check against
  const title = contentWords(page.title);
  if (!title.size) return true; // a title like "Voyager 1" carries no content words

  let overlap = 0;
  let extra = 0;
  for (const word of title) (wanted.has(word) ? (overlap += 1) : (extra += 1));
  return overlap >= 1 && extra <= 1;
}

/**
 * Wikipedia background for a subject, with one retry.
 *
 * A spoken subject still carries verbs — "Roman aqueducts move water uphill" — and
 * the search ranks on all of it, so the relevant article can be ranked below
 * something that merely shares a word. When the relevance check leaves nothing, the
 * retry asks again with just the leading nouns, which is what actually names the
 * thing. Both calls are free and land in well under a second.
 */
export async function lookupBackground(topic) {
  const first = await wikiLookup(topic, { limit: 4 });
  const kept = first.filter((page) => wikiIsRelevant(page, topic));
  if (kept.length) return kept.slice(0, 2);

  const nouns = [...contentWords(topic)].slice(0, 2).join(" ");
  if (!nouns || nouns === topic.toLowerCase()) return [];
  const retry = await wikiLookup(nouns, { limit: 3 });
  return retry.filter((page) => wikiIsRelevant(page, nouns)).slice(0, 2);
}

/**
 * Research started the moment the listener names their subject, while they are
 * still being asked the other two questions.
 *
 * The complaint this answers: the hosts went to air before the search came back
 * and talked around the subject. Thirty seconds of setup is thirty seconds the
 * search can already have been running.
 *
 * Keyed by scope, so a listener who backs out and names a different subject gets a
 * different entry and the stale one is never read. Nothing here is awaited by the
 * setup flow — it is a head start, not a step.
 */
const primed = new Map(); // researchId -> { at, promise, subject, query, mode }

/**
 * Keyed by an opaque id minted for each description, not by the listener.
 *
 * A first-time visitor has no listener id — one is created when they finish the
 * setup — so keying on it meant the head start was silently skipped for exactly
 * the people the setup conversation exists for. The id is minted when the subject
 * is named, held by the client through the other two questions, and handed back
 * with the finished podcast, which also makes ownership explicit: this research
 * belongs to this description of this show and to nothing else.
 *
 * A new focus mints a new id, so nothing is ever reused across a change of mind.
 */

/** What the research was gathered under. Material collected for a current-affairs
 *  show is not interchangeable with material collected for an evergreen one. */
const researchMode = (show = {}) => ({
  freshness: show.freshness ?? null,
  families: [...(show.families ?? [])].sort().join(","),
});

const sameMode = (a, b) => a.freshness === b.freshness && a.families === b.families;

export function primeResearch({ researchId, query, subject, show }) {
  if (!researchId) return null;
  const promise = researchForHosts({ query, subject, show, useWire: false }).catch((err) => {
    console.warn(`[research] primed round failed: ${err.message}`);
    return null;
  });
  primed.set(researchId, { at: Date.now(), promise, subject, query, mode: researchMode(show) });
  // Two podcasts in a session is normal; twenty is a leak.
  if (primed.size > 8) primed.delete(primed.keys().next().value);
  return promise;
}

export function dropPrimedResearch(researchId) {
  if (researchId) primed.delete(researchId);
}

/**
 * Collect a head start, if it belongs to this show, was gathered under the same
 * rules, is still fresh, and is strongly about the thing the hosts have actually
 * reached first.
 *
 * All four conditions matter, but the last is the one worth spelling out. The head
 * start is research into whatever the listener said the show was about; the first
 * subject of the episode is one specific thing. Material about Roman roads passed
 * off as evidence about Roman aqueducts is the same failure as no research at all,
 * wearing a citation. Some duplicated work is much cheaper than that.
 */
export async function claimPrimedResearch({ researchId, subject, show, maxAgeMs = 10 * 60 * 1000 }) {
  const entry = researchId ? primed.get(researchId) : null;
  if (!entry) return null;
  const stale = Date.now() - entry.at > maxAgeMs;
  const wrongMode = !sameMode(entry.mode, researchMode(show));
  // Compared against what was actually searched, not against the tidied-up subject
  // derived from it. "Ancient history. Start with Roman aqueducts." is the request
  // the material came back from; a derived `about` can lose the starter, and then a
  // head start that covered exactly this subject gets thrown away for want of the
  // word. The strong rule is unchanged — this makes the comparison more specific,
  // not more permissive.
  const searched = entry.query || entry.subject;
  const wrongSubject = subject && !stronglyAbout(searched, subject);
  if (stale || wrongMode || wrongSubject) {
    primed.delete(researchId);
    return null;
  }
  primed.delete(researchId); // worth having once; re-reading it recycles the same page
  const research = await entry.promise;
  return research?.usable ? research : null;
}

/**
 * Are these two descriptions about the same thing — not merely adjacent to it?
 *
 * "Roman roads" and "Roman aqueducts" share a word and are different subjects, so
 * one shared token is never enough on its own. A subject named in a single word
 * has to appear whole in the other.
 */
export function stronglyAbout(a, b) {
  const left = contentWords(a);
  const right = contentWords(b);
  if (!left.size || !right.size) return false;
  const shared = [...right].filter((word) => left.has(word));
  const narrower = Math.min(left.size, right.size);
  if (narrower === 1) return shared.length === 1;
  return shared.length >= 2;
}

/**
 * One research round. Never throws: the hosts can always talk from what they have
 * and say what they lack, and a dead upstream is not a reason to drop a caller.
 *
 * @param {object}  o
 * @param {string}  o.query        what to look into, in plain words
 * @param {string}  o.context      what is on air, so pronouns resolve
 * @param {object}  o.show         the show definition (families, freshness, wire)
 * @param {boolean} o.useWire      consult NewsMCP as well (news shows, named subject)
 */
export async function researchTopic({
  query,
  subject = null,
  context = "",
  show = {},
  useWire = false,
  deadlineMs = config.timeouts.research,
  signal,
  researchAngle = "",
}) {
  const started = Date.now();
  const domains = domainsFor(show.families ?? []);
  // The web search wants the whole instruction; Wikipedia wants the subject. Handed
  // a spoken sentence, its title search matches on an incidental word and returns
  // an article about somewhere else entirely.
  const topic = (subject || query || "").trim();

  const web = withDeadline(
    webResearch({
      query,
      context,
      domains,
      freshness: show.freshness ?? null,
      timeoutMs: deadlineMs,
      signal,
      researchAngle,
    }).catch((err) => {
      console.warn(`[research] web search failed: ${err.message}`);
      return null;
    }),
    deadlineMs,
    null,
  );

  const wiki = withDeadline(
    lookupBackground(topic).catch((err) => {
      console.warn(`[research] wikipedia failed: ${err.message}`);
      return [];
    }),
    Math.min(deadlineMs, config.timeouts.wikipedia * 2 + 1000),
    [],
  );

  const wire = useWire
    ? withDeadline(
        newsResearch({ question: query, maxAgeHours: show.wireMaxAgeHours ?? 72 }).catch((err) => {
          console.warn(`[research] newsmcp failed: ${err.message}`);
          return [];
        }),
        deadlineMs,
        [],
      )
    : Promise.resolve([]);

  const [summary, pages, events] = await Promise.all([web, wiki, wire]);
  const sources = [
    ...(summary?.sources ?? []),
    ...wireSources(events ?? []),
    ...wikiSources(pages ?? []),
  ];

  return {
    query,
    web: summary,
    wiki: pages ?? [],
    stories: events ?? [],
    sources,
    empty: !summary && !(pages ?? []).length && !(events ?? []).length,
    // Whether there is enough here to say anything factual on air. See the note on
    // `isUsable` — this is a gate the show layer enforces, not a hint to a prompt.
    usable: isUsable({ summary, pages, events, show }),
    elapsedMs: Date.now() - started,
  };
}

const HOST_RESEARCH_ANGLES = {
  ari: "Find the concrete mechanism, chronology, measurements, and numbers. Prefer primary documents and technically precise reporting.",
  dev: "Independently investigate consequences, human stakes, disputes, and the strongest useful connection beyond the obvious summary.",
};

/**
 * Run the hosts' two desks concurrently behind one wall-clock deadline. Each desk
 * receives the same cancellation signal but a different assignment, and its
 * provenance survives failure so the script can never imply that an empty desk
 * researched a fact. `researcher` is injectable for offline orchestration tests.
 */
export async function researchForHosts(
  args,
  { researcher = researchTopic, deadlineMs = args.deadlineMs ?? config.timeouts.research } = {},
) {
  const started = Date.now();
  const controller = new AbortController();
  const timedOut = Symbol("host-research-timeout");
  let resolveDeadline;
  const deadline = new Promise((resolve) => { resolveDeadline = resolve; });
  const finishDeadline = (reason) => {
    if (!controller.signal.aborted) controller.abort(reason);
    resolveDeadline(timedOut);
  };
  const timer = setTimeout(
    () => finishDeadline(new Error("host research deadline")),
    Math.max(1, deadlineMs),
  );
  const parentAbort = () => finishDeadline(args.signal?.reason);
  if (args.signal) {
    if (args.signal.aborted) parentAbort();
    else args.signal.addEventListener("abort", parentAbort, { once: true });
  }

  // Let each desk's internal source collectors settle just before the shared wall
  // clock expires. That small margin preserves a Wikipedia result instead of the
  // outer race discarding it at the same instant as the web-search timeout.
  const laneDeadlineMs = Math.max(1, deadlineMs - Math.min(500, Math.floor(deadlineMs / 5)));

  const run = (speaker) => Promise.resolve()
    .then(() => researcher({
      ...args,
      deadlineMs: laneDeadlineMs,
      signal: controller.signal,
      lane: speaker,
      // One metered wire lookup is shared in the final notes; making both desks
      // ask the same wire service would add no independence and risks budget.
      useWire: !!args.useWire && speaker === "ari",
      researchAngle: HOST_RESEARCH_ANGLES[speaker],
    }))
    .then((research) => ({ ok: true, research }))
    .catch((error) => ({ ok: false, error }));

  // Construct both jobs before awaiting either. This is also observable through
  // the injected boundary: neither desk can wait for the other to finish.
  const jobs = ["ari", "dev"].map((speaker) => ({ speaker, promise: run(speaker) }));
  const settled = await Promise.all(
    jobs.map(({ promise }) => Promise.race([promise, deadline])),
  );
  clearTimeout(timer);
  if (args.signal) args.signal.removeEventListener("abort", parentAbort);

  const packets = settled.map((result, index) => {
    const speaker = jobs[index].speaker;
    if (result === timedOut) {
      return {
        speaker,
        angle: HOST_RESEARCH_ANGLES[speaker],
        status: "timed_out",
        usable: false,
        sources: [],
        research: null,
        error: "shared research deadline elapsed",
      };
    }
    if (!result.ok) {
      return {
        speaker,
        angle: HOST_RESEARCH_ANGLES[speaker],
        status: "failed",
        usable: false,
        sources: [],
        research: null,
        error: String(result.error?.message ?? result.error ?? "research failed").slice(0, 240),
      };
    }
    const research = result.research ?? null;
    return {
      speaker,
      angle: HOST_RESEARCH_ANGLES[speaker],
      status: research?.usable ? "ready" : "empty",
      usable: !!research?.usable,
      sources: [...(research?.sources ?? [])],
      research,
      error: null,
    };
  });
  const sources = [];
  const seen = new Set();
  for (const source of packets.flatMap((packet) => packet.sources)) {
    if (!source?.url || seen.has(source.url)) continue;
    seen.add(source.url);
    sources.push(source);
  }
  return {
    packets,
    usable: packets.some((packet) => packet.usable),
    sources: sources.slice(0, 12),
    elapsedMs: Date.now() - started,
  };
}

/**
 * Is this enough to talk from?
 *
 * The failure this exists for: two web searches timed out at twenty-two seconds,
 * the round returned successfully with nothing in it, and the hosts were handed a
 * subject and a prompt saying "answer from what you do have" — so they invented
 * it. A prompt is not a gate. This is the gate, and the show layer refuses to
 * generate a factual script without it.
 *
 * Wikipedia counts as evidence for a subject that is not about what is happening
 * now. For a current-affairs show it is background and nothing more: an
 * encyclopaedia article is not reporting, and a podcast that claims to cover the
 * last forty-eight hours cannot stand one up as though it were.
 */
export function isUsable({ summary, pages = [], events = [], show = {} }) {
  // Text and a link, together. A summary with no citation behind it is the model
  // talking from memory with a search tool attached, which is the thing the hosts
  // are not allowed to do — and it is indistinguishable from real reporting once
  // it reaches a script.
  if (summary?.summary?.trim() && (summary.sources ?? []).some((s) => isHttpUrl(s?.url))) return true;
  if (
    events.some(
      (e) =>
        (e.headline?.trim() || e.abstract?.trim()) &&
        (e.sources ?? []).some((url) => isHttpUrl(url)),
    )
  ) {
    return true;
  }
  const currentAffairs = !!show.freshness;
  return !currentAffairs && pages.some((p) => p.extract?.trim() && isHttpUrl(p.url));
}

function isHttpUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
