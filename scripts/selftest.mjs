// Offline checks for the logic that is awkward to exercise against live APIs:
// profile write races, the incremental JSON reader, subject screening, timeouts.
// Run with: npm run check
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.NEWSCAST_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "newscast-test-"));
const DATA_DIR = process.env.NEWSCAST_DATA_DIR;
// Point the wire at a closed port: this suite must never be able to spend a
// call from the shared keyless budget, whatever a future test does.
process.env.NEWSMCP_URL = "http://127.0.0.1:1/mcp";
// Same for OpenAI. Queuing a caller renders its stock lines, and this suite must
// never reach a real endpoint to do it.
process.env.OPENAI_BASE_URL = "http://127.0.0.1:1/v1";
// And Wikipedia. It is a real public endpoint with no key, which is exactly why it
// was quietly the one upstream this "offline" suite was still calling.
process.env.WIKIPEDIA_API_URL = "http://127.0.0.1:1/w/api.php";
// And Anthropic. Pointing it at a closed port is what lets a test tell "the gate
// stopped us before the model was called" apart from "the model was called and the
// call failed" — the two put different words on air.
process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:1";
process.env.ANTHROPIC_API_KEY ??= "test";
process.env.OPENAI_API_KEY ??= "test";

const { ProfileStore } = await import("../src/profile.js");
const { TurnExtractor } = await import("../src/llm.js");
const { queryForQuestion, stripInlineCitations } = await import("../src/research.js");
const { fetchWithTimeout, readBody, withDeadline } = await import("../src/http.js");
const { parseWireTime, screenStories, storyKey } = await import("../src/newsmcp.js");
const { labelWeight, normalizeText, phraseMatches } = await import("../src/profile.js");
const { domainsFor, isMajorNews, majorSourceCount, onDomain } = await import("../src/outlets.js");
const { defineShow, inferFamilies, isCurrentAffairs, PRESETS } = await import("../src/showdef.js");
const { conciseSubject, saidByCaller, topicKey } = await import("../src/show.js");
const { wikiIsRelevant } = await import("../src/research.js");

// Speech for the stock call-in lines is fired and forgotten, and against a closed
// port it warns once per line. Those warnings are the expected behaviour under
// test, not a result, so they are held back and only shown if something fails.
const warnings = [];
console.warn = (...args) => warnings.push(args.join(" "));

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/* ---------- profile: concurrent writes must not lose updates ---------- */

test("concurrent first loads share one object", async () => {
  const store = new ProfileStore();
  const [a, b] = await Promise.all([store.load("racer"), store.load("racer")]);
  assert.equal(a, b, "two concurrent loads returned different objects");
});

test("concurrent pace nudges both persist", async () => {
  const store = new ProfileStore();
  await Promise.all([
    store.recordPace("dual", { action: "deeper", title: "One" }),
    store.recordPace("dual", { action: "deeper", title: "Two" }),
  ]);
  const profile = await store.load("dual");
  assert.equal(profile.log.length, 2, `expected 2 log entries, got ${profile.log.length}`);
  assert.equal(profile.pacing, 2, `expected pacing to reach 2, got ${profile.pacing}`);
  const onDisk = JSON.parse(
    await fs.readFile(path.join(DATA_DIR, "profiles", "dual.json"), "utf8"),
  );
  assert.equal(onDisk.log.length, 2, "the flushed file lost an update");
});

test("markCovered is additive across concurrent calls", async () => {
  const store = new ProfileStore();
  await Promise.all([store.markCovered("cov", ["a"]), store.markCovered("cov", ["b"])]);
  const profile = await store.load("cov");
  assert.deepEqual(profile.covered.sort(), ["a", "b"]);
});

test("removing an interest also clears its mute", async () => {
  const store = new ProfileStore();
  await store.setMuted("unmute", "banking", true);
  await store.setInterest("unmute", { label: "banking", remove: true });
  const profile = await store.load("unmute");
  assert.equal(profile.muted.includes("banking"), false);
});

/* ---------- profile: listening is not a signal ---------- */

test("pacing is clamped and 'hurry' never touches interests", async () => {
  const store = new ProfileStore();
  for (let i = 0; i < 5; i++) {
    await store.recordPace("hasty", { action: "hurry", title: "A long segment about Testa McPlaceholder" });
  }
  const profile = await store.load("hasty");
  assert.equal(profile.pacing, -2, `pacing should floor at -2, got ${profile.pacing}`);
  // The whole point: asking the hosts to speed up says nothing about the people in
  // the segment, and must not put any of them in the profile.
  assert.deepEqual(Object.keys(profile.topics), [], "hurrying learned a topic");
  assert.deepEqual(Object.keys(profile.entities), [], "hurrying learned an entity");
});

test("'deeper' raises pacing and the subject, with its provenance", async () => {
  const store = new ProfileStore();
  await store.recordPace("keen", { action: "deeper", title: "Voyager 1", topics: ["Voyager 1"] });
  const profile = await store.load("keen");
  assert.equal(profile.pacing, 1);
  const topic = store.interests(profile).topics.find((t) => t.label === "Voyager 1");
  assert.ok(topic, "the subject was not recorded");
  assert.equal(topic.source, "deeper");
  assert.match(topic.why, /deeper/i);
});

test("an interest cannot be learned without saying where it came from", async () => {
  const store = new ProfileStore();
  await assert.rejects(
    () => store.applyInterests("anon", { labels: ["banking"] }),
    /source/,
    "an unattributable interest was accepted",
  );
});

test("caller interests carry their provenance and reach the brief", async () => {
  const store = new ProfileStore();
  await store.applyInterests("asker", {
    labels: ["space exploration"],
    entities: ["Voyager 1"],
    source: "caller",
    scope: "sc_space",
  });
  const profile = await store.load("asker");
  assert.equal(store.interests(profile).topics[0].source, "caller");
  assert.equal(store.interests(profile).topics[0].scope, "sc_space");
  assert.match(store.brief(profile, { scope: "sc_space" }), /space exploration/);
});

test("interests learned before provenance are kept, flagged, and do not steer", async () => {
  const store = new ProfileStore();
  const dir = path.join(DATA_DIR, "profiles");
  await fs.mkdir(dir, { recursive: true });
  // A profile written by the version that learned every name it read out.
  await fs.writeFile(
    path.join(dir, "oldtimer.json"),
    JSON.stringify({
      id: "oldtimer",
      topics: { banking: { score: 4, updatedAt: new Date().toISOString() } },
      entities: {
        "Testa McPlaceholder": { score: 3, updatedAt: new Date().toISOString() },
        "Ada Lovelace": { score: 3, updatedAt: new Date().toISOString(), pinned: true },
      },
      feedback: [{ at: new Date().toISOString(), verdict: "up", headline: "Something" }],
      callIns: [],
      covered: [],
      muted: [],
    }),
  );
  const profile = await store.load("oldtimer");
  const { topics, entities } = store.interests(profile);
  assert.ok(entities.find((e) => e.label === "Testa McPlaceholder"), "the listener's data was deleted");
  assert.equal(
    entities.find((e) => e.label === "Testa McPlaceholder").source,
    "legacy",
    "an unexplainable interest was presented as a deliberate choice",
  );
  // Pinned entries were only ever set by hand, so they keep that provenance.
  assert.equal(entities.find((e) => e.label === "Ada Lovelace").source, "manual");
  assert.equal(topics[0].source, "legacy");
  // Neither steers any podcast: one has no explanation, and the other has no
  // podcast — it was added before shows were told apart, so there is no way to
  // know which one the listener meant it for.
  const brief = store.brief(profile, { scope: "sc_anything" });
  assert.equal(/Testa McPlaceholder/.test(brief), false, `legacy name steered the show: ${brief}`);
  assert.equal(/Ada Lovelace/.test(brief), false, `an unscoped interest steered a show: ${brief}`);
  assert.ok(profile.log.length >= 1, "the old ratings log was dropped instead of migrated");

  // Raising it again on a podcast adopts it there, and then it steers that one.
  await store.applyInterests("oldtimer", {
    entities: ["Ada Lovelace"],
    source: "caller",
    scope: "sc_computing",
  });
  const adopted = await store.load("oldtimer");
  assert.match(store.brief(adopted, { scope: "sc_computing" }), /Ada Lovelace/);
  assert.equal(/Ada Lovelace/.test(store.brief(adopted, { scope: "sc_other" })), false);
});

test("an unexplained interest does not steer what gets picked", async () => {
  // The panel tells the listener these no longer steer the show. This is where
  // that has to be true: a positive legacy score must not move the ranking.
  const store = new ProfileStore();
  const dir = path.join(DATA_DIR, "profiles");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "ghost.json"),
    JSON.stringify({
      id: "ghost",
      topics: { banking: { score: 6, updatedAt: new Date().toISOString() } },
      entities: {},
      callIns: [],
      covered: [],
      muted: [],
    }),
  );
  const profile = await store.load("ghost");
  const story = { sector: "banking", eventType: "deals.merger", headline: "A merger", entities: [] };
  assert.equal(store.affinity(profile, story), 0, "a legacy interest promoted a story");

  // ...but an explicit dislike, whenever it was recorded, still counts.
  await store.setPreference("ghost", "banking", "less");
  assert.ok(store.affinity(await store.load("ghost"), story) < 0, "a stated dislike stopped counting");
});

test("old high-scoring rows cannot crowd new ones out of the brief", async () => {
  const store = new ProfileStore();
  const dir = path.join(DATA_DIR, "profiles");
  await fs.mkdir(dir, { recursive: true });
  const topics = {};
  // Twelve of them: more than the brief's limit, all outranking a fresh interest.
  for (let i = 0; i < 12; i++) {
    topics[`old subject ${i}`] = { score: 9, updatedAt: new Date().toISOString() };
  }
  await fs.writeFile(
    path.join(dir, "crowded.json"),
    JSON.stringify({ id: "crowded", topics, entities: {}, callIns: [], covered: [], muted: [] }),
  );
  await store.load("crowded");
  await store.applyInterests("crowded", {
    labels: ["deep sea mining"],
    source: "caller",
    scope: "sc_ocean",
  });
  const profile = await store.load("crowded");

  const brief = store.brief(profile, { scope: "sc_ocean" });
  assert.match(brief, /deep sea mining/, `the caller's own interest was crowded out: ${brief}`);
  for (let i = 0; i < 12; i++) {
    assert.equal(brief.includes(`old subject ${i}`), false, "an unexplained interest steered the show");
  }
  // The panel gets the two lists separately, for the same reason.
  assert.deepEqual(
    store.interests(profile, { include: "current", scope: "sc_ocean" }).topics.map((t) => t.label),
    ["deep sea mining"],
  );
  assert.equal(
    store.interests(profile, { include: "other", scope: "sc_ocean", limit: 100 }).topics.length,
    12,
  );
});

/* ---------- one profile, many podcasts ---------- */

test("a podcast is scoped by its subject, not by when it was created", async () => {
  const { showScope, defineShow, PRESETS } = await import("../src/showdef.js");
  const history = defineShow({ presetId: "history" });
  const nfl = defineShow({ presetId: "nfl" });
  assert.notEqual(showScope(history), showScope(nfl));
  // The same podcast set up again is the same podcast, and keeps what it learned.
  assert.equal(showScope(history), showScope(defineShow({ presetId: "history" })));
  // Rewriting the angle of a show about the NFL leaves it a show about the NFL.
  const preset = PRESETS.find((p) => p.id === "nfl");
  assert.equal(
    showScope(nfl),
    showScope(defineShow({ presetId: "nfl", about: preset.about, episodes: preset.episodes, angle: "and funnier" })),
  );
  assert.notEqual(showScope(nfl), showScope(defineShow({ about: "the NBA" })));
});

test("the Eagles do not follow the listener into a podcast about history", async () => {
  // A listener who had called in about the Eagles on a football
  // podcast started a new one about history and got Chip Kelly's scheme and the
  // Roseman rebuild. The show definition was clean and the steer was null — it
  // came in through the profile brief.
  const { defineShow, showScope } = await import("../src/showdef.js");
  const football = showScope(defineShow({ presetId: "nfl" }));
  const history = showScope(defineShow({ presetId: "history" }));

  const store = new ProfileStore();
  await store.recordCallIn("fan", { text: "what is going on with the Eagles offensive line", scope: football });
  await store.applyInterests("fan", {
    labels: ["nfl roster moves"],
    entities: ["Philadelphia Eagles", "Howie Roseman"],
    source: "caller",
    scope: football,
  });
  const profile = await store.load("fan");

  const onFootball = store.brief(profile, { scope: football });
  assert.match(onFootball, /Philadelphia Eagles/, "the football show forgot its own caller");
  assert.match(onFootball, /offensive line/, "the football show lost its own last call");

  const onHistory = store.brief(profile, { scope: history });
  for (const leak of ["Philadelphia Eagles", "Howie Roseman", "nfl roster moves", "offensive line"]) {
    assert.equal(
      onHistory.includes(leak),
      false,
      `"${leak}" followed the listener into an unrelated podcast: ${onHistory}`,
    );
  }
  assert.equal(onHistory, "no history yet — this is a first listen");
});

test("story ranking is scoped too, so an old interest cannot promote a story", async () => {
  const store = new ProfileStore();
  await store.applyInterests("ranker2", {
    entities: ["Philadelphia Eagles"],
    source: "caller",
    scope: "sc_football",
  });
  const profile = await store.load("ranker2");
  const story = {
    sector: "sports_recreation",
    eventType: "sports.match_result",
    headline: "Philadelphia Eagles win",
    entities: [{ name: "Philadelphia Eagles", salience: 0.9 }],
  };
  assert.ok(store.affinity(profile, story, { scope: "sc_football" }) > 0, "the football show lost its own ranking");
  assert.equal(store.affinity(profile, story, { scope: "sc_history" }), 0, "an interest ranked for another podcast");
});

test("what someone asked to hear less of follows them; what they asked for does not", async () => {
  // The asymmetry is the point: suppression can only ever take something away, so
  // it is safe everywhere. Promotion decides what an episode is about.
  const store = new ProfileStore();
  await store.setPreference("prefs", "sports", "less", { scope: "sc_news" });
  await store.setPreference("prefs", "the technical detail", "more", { scope: "sc_news" });
  const profile = await store.load("prefs");

  const elsewhere = store.brief(profile, { scope: "sc_baking" });
  assert.match(elsewhere, /less sports/, "a mute stopped applying on another podcast");
  assert.equal(
    elsewhere.includes("technical detail"),
    false,
    "a positive preference followed the listener to an unrelated podcast",
  );
  assert.match(store.brief(profile, { scope: "sc_news" }), /technical detail/);

  const sport = { sector: "sports_recreation", eventType: "sports.match_result", headline: "A final", entities: [] };
  const other = { sector: "banking", eventType: "deals.merger", headline: "A merger", entities: [] };
  assert.ok(
    store.affinity(profile, sport, { scope: "sc_baking" }) <
      store.affinity(profile, other, { scope: "sc_baking" }) - 5,
    "a mute stopped sinking stories on another podcast",
  );
});

test("pacing is about delivery, so it is not scoped", async () => {
  const store = new ProfileStore();
  await store.recordPace("pacer", { action: "deeper", title: "A subject", scope: "sc_one" });
  await store.recordPace("pacer", { action: "deeper", title: "A subject", scope: "sc_one" });
  const profile = await store.load("pacer");
  assert.equal(profile.pacing, 2, "how fast someone wants to be talked to is not a per-show setting");
});

test("the showrunner knows which podcast it is", async () => {
  const { showFor } = await import("../src/show.js");
  const { defineShow, showScope } = await import("../src/showdef.js");
  const show = showFor("scoped-show");
  const definition = defineShow({ presetId: "history" });
  await show.define(definition);
  assert.equal(show.scope, showScope(definition));
  assert.equal(show.status().show.scope, show.scope);

  // Changing the podcast changes the scope, so the next episode learns elsewhere.
  await show.define(defineShow({ presetId: "nfl" }));
  assert.notEqual(show.scope, showScope(definition));
});

/* ---------- what a caller actually said ---------- */


test("a stated dislike rejects the phrase, not every word containing it", () => {
  // "less AI" must not delete Thailand, and "less rail" must not delete Israel.
  const rejected = ["AI", "rail"];
  const norm = (v) => String(v).toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const isRejected = (value) =>
    rejected.some((label) => {
      const l = norm(label);
      const n = norm(value);
      return l === n || phraseMatches(l, n) || phraseMatches(n, l);
    });
  assert.equal(isRejected("Thailand"), false, "'less AI' deleted Thailand");
  assert.equal(isRejected("Israel"), false, "'less rail' deleted Israel");
  assert.equal(isRejected("AI"), true);
  assert.equal(isRejected("AI safety"), true, "a phrase containing the rejected label survived");
});

test("a spoken question is cut down to something searchable", () => {
  assert.equal(
    conciseSubject(
      "Start with this: how did Roman aqueducts move water uphill? I would like more engineering explanations.",
    ),
    "Roman aqueducts move water uphill",
  );
  assert.equal(conciseSubject("hey guys, can you talk about the Strait of Hormuz"), "Strait of Hormuz");
  assert.ok(conciseSubject("tell me more about the Chicago Bears").includes("Chicago Bears"));
  assert.ok(conciseSubject("").length === 0 || conciseSubject("") === "");
});

test("an article that merely shares a word is not treated as background", () => {
  const subject = "Roman aqueducts move water uphill";
  assert.ok(wikiIsRelevant({ title: "Roman aqueduct", extract: "" }, subject));
  assert.equal(
    wikiIsRelevant({ title: "Roman funerary practices", extract: "Roman burial rites…" }, subject),
    false,
    "an article about a different Roman subject passed as background",
  );
  assert.equal(wikiIsRelevant({ title: "Glasgow", extract: "Glasgow is a city…" }, subject), false);
  // A title with no content words of its own — "Voyager 1" — must still pass.
  assert.ok(wikiIsRelevant({ title: "Voyager 1", extract: "" }, "Voyager 1 still transmitting"));
});

test("a name is only learned if the caller said it", () => {
  const q = "what's the latest with Voyager one and the deep space network";
  assert.ok(saidByCaller("Voyager", q));
  assert.ok(saidByCaller("Deep Space Network", q));
  // The model listed someone the hosts named in their answer. Not the caller's.
  assert.equal(saidByCaller("Testa McPlaceholder", q), false);
  assert.equal(saidByCaller("NASA", q), false);
});

test("a partial name match is not enough", () => {
  assert.equal(saidByCaller("Elon Musk", "what did Elon Gonzalez say about it"), false);
  assert.ok(saidByCaller("Elon Musk", "what did elon musk say about it"));
});

/* ---------- subject screening: big stories, real outlets ---------- */

const wireStory = (over = {}) => ({
  headline: "Something happened",
  newsrooms: 30,
  sources: ["https://apnews.com/article/x", "https://www.reuters.com/y"],
  lastSeen: new Date().toISOString(),
  ...over,
});

test("a story no national outlet carried does not reach the episode", () => {
  const kept = screenStories([
    wireStory({ headline: "Big one" }),
    wireStory({ headline: "Shooting range in India", sources: ["https://example-local.in/a"] }),
  ]);
  assert.deepEqual(kept.map((s) => s.headline), ["Big one"]);
});

test("a story barely anyone ran does not reach the episode", () => {
  const kept = screenStories([wireStory({ headline: "Local crime", newsrooms: 2 })]);
  assert.deepEqual(kept, []);
});

test("caller wire results are age-bounded, not just outlet-screened", () => {
  const old = new Date(Date.now() - 8 * 86400000).toISOString();
  const kept = screenStories(
    [wireStory({ headline: "Last week's model release", lastSeen: old }), wireStory({ headline: "Today" })],
    { maxAgeHours: 72 },
  );
  assert.deepEqual(kept.map((s) => s.headline), ["Today"]);
});

test("screening ranks the freshest first and honours the limit", () => {
  const kept = screenStories(
    [
      wireStory({ headline: "Older", lastSeen: new Date(Date.now() - 40 * 3600000).toISOString() }),
      wireStory({ headline: "Newer" }),
    ],
    { limit: 1 },
  );
  assert.deepEqual(kept.map((s) => s.headline), ["Newer"]);
});

test("subdomains count as their parent outlet", () => {
  assert.ok(onDomain("https://science.nasa.gov/x", "nasa.gov"));
  assert.ok(isMajorNews("https://amp.cnn.com/story"));
  assert.equal(isMajorNews("https://notcnn.com/story"), false, "a lookalike domain passed");
  assert.equal(majorSourceCount({ sources: ["https://apnews.com/a", "https://blog.example/b"] }), 1);
});

test("the search allow-list is capped and mixes families rather than concatenating", () => {
  const news = domainsFor(["news"]);
  assert.ok(news.length <= 20 && news.length > 0);
  const mixed = domainsFor(["sports", "news"]);
  assert.ok(mixed.length <= 20, `allow-list overflowed the tool's ceiling: ${mixed.length}`);
  assert.ok(mixed.includes("espn.com"), "the sports desk was pushed out by the news desk");
  assert.ok(mixed.includes("apnews.com"), "the news desk was dropped entirely");
  assert.deepEqual(domainsFor([]), [], "an unclassified show should search the open web");
});

/* ---------- show definitions ---------- */

test("classification is token-aware, not substring", () => {
  // "explains" contains "ai"; "start" contains "art"; "plainly" contains "plain".
  assert.deepEqual(inferFamilies("it explains things and does not start arguments"), []);
  assert.deepEqual(inferFamilies("artificial intelligence and machine learning"), ["tech"]);
  assert.deepEqual(inferFamilies("the NFL and its playoffs"), ["sports"]);
});

test("a history show gets no recency window and spends no wire call", () => {
  const show = defineShow({
    about: "the history of Roman engineering",
    episodes: "one aqueduct, followed from quarry to collapse",
    angle: "says where the record is contested",
  });
  assert.deepEqual(show.families, ["reference"]);
  assert.equal(show.freshness, null, "a history show was asked for this week's Romans");
  assert.equal(show.useWire, false, "a history show spent a metered news call");
});

test("a current-affairs show gets a 48-hour window", () => {
  const show = defineShow({
    about: "world news",
    episodes: "the biggest stories today",
    angle: "no filler",
  });
  assert.equal(show.freshness, "the last 48 hours");
  assert.equal(show.useWire, true);
});

test("an AI show is treated as news, not as a weekly digest", () => {
  const preset = PRESETS.find((p) => p.id === "tech");
  assert.equal(preset.freshness, "the last 48 hours", "last week's release is not this episode");
});

test("editing a preset re-classifies it instead of keeping the old sources", () => {
  const news = PRESETS.find((p) => p.id === "news");
  const edited = defineShow({
    presetId: "news",
    about: "Formula One",
    episodes: news.episodes,
    angle: news.angle,
  });
  assert.notDeepEqual(edited.families, news.families, "an edited preset kept the wire-service list");
  assert.equal(edited.presetId, "news");
  assert.equal(edited.title, "Formula One");
});

test("rewriting only the angle keeps a preset's curated sources", async () => {
  const markets = PRESETS.find((p) => p.id === "markets");
  const show = defineShow({
    presetId: "markets",
    about: markets.about,
    episodes: markets.episodes,
    angle: "and it is funny about it",
  });
  assert.deepEqual(show.families, markets.families, "an angle edit threw away the financial desks");
  assert.equal(show.freshness, markets.freshness);
  assert.equal(show.useWire, markets.useWire);
  assert.equal(show.title, markets.name);
});

test("every preset keeps its curated research mode through a definition round trip", () => {
  for (const preset of PRESETS) {
    const described = defineShow({ presetId: preset.id });
    const saved = defineShow({ ...described, presetId: preset.id });
    for (const definition of [described, saved]) {
      assert.deepEqual(definition.families, preset.families, `${preset.id} changed research desks`);
      assert.equal(definition.freshness, preset.freshness, `${preset.id} changed its time window`);
      assert.equal(definition.useWire, preset.useWire, `${preset.id} changed its wire policy`);
      assert.equal(definition.title, preset.name, `${preset.id} changed its series title`);
    }
  }
});

test("a podcast with no subject is refused", () => {
  assert.throws(() => defineShow({ episodes: "things", angle: "well" }), /about/i);
});

test("the other two fields are filled in rather than blocking", () => {
  const show = defineShow({ about: "sourdough" });
  assert.ok(show.episodes.length > 0);
  assert.ok(show.angle.length > 0);
  assert.equal(show.presetId, "custom");
});

test("generated series and episode metadata is normalized once and stays stable", () => {
  const createdAt = "2026-08-12T09:30:00.000Z";
  const episodeCreatedAt = "2026-08-13T09:30:00.000Z";
  const history = Array.from({ length: 15 }, (_, index) => ({
    episodeId: `episode_${index}`,
    episodeNumber: index + 1,
    episodeTitle: `Episode ${index + 1}`,
    episodeBrief: `Brief ${index + 1}`,
    episodeFocus: `Facet ${index + 1}`,
  }));
  const show = defineShow({
    about: "the Apollo moon landing",
    episodes: "one technical problem at a time",
    angle: "engineering decisions in their historical context",
    title: `  ${"T".repeat(100)}  `,
    brief: "B".repeat(320),
    episodeTitle: "E".repeat(140),
    episodeBrief: "D".repeat(380),
    episodeFocus: "F".repeat(300),
    episodeNumber: 12000,
    episodeHistory: history,
    seriesId: "series_apollo",
    episodeId: "episode_apollo_15",
    createdAt,
    episodeCreatedAt,
  });

  assert.equal(show.title.length, 80);
  assert.equal(show.brief.length, 280);
  assert.equal(show.episodeTitle.length, 100);
  assert.equal(show.episodeBrief.length, 320);
  assert.equal(show.episodeFocus.length, 240);
  assert.equal(show.episodeNumber, 9999);
  assert.equal(show.episodeHistory.length, 12, "unbounded episode history reached the prompt");
  assert.equal(show.episodeHistory[0].episodeFocus, "Facet 4");
  assert.match(show.seriesId, /^series_[a-f0-9]{16}$/);
  assert.notEqual(show.seriesId, "series_apollo", "caller input replaced the derived series identity");
  assert.match(show.episodeId, /^episode_[a-f0-9]{18}$/);
  assert.notEqual(show.episodeId, "episode_apollo_15", "caller input replaced the derived episode identity");
  assert.equal(show.createdAt, createdAt);
  assert.equal(show.episodeCreatedAt, episodeCreatedAt);

  const restored = defineShow(show);
  for (const field of ["title", "brief", "seriesId", "episodeId", "createdAt", "episodeCreatedAt"]) {
    assert.equal(restored[field], show[field], `${field} changed when the saved definition was restored`);
  }
});

test("a new episode changes the facet without changing the series identity", async () => {
  const { nextEpisodeDefinition } = await import("../src/showdef.js");
  const series = defineShow({
    about: "the Apollo moon landing",
    episodes: "one technical problem at a time",
    angle: "engineering decisions in their historical context",
    title: "The Eagle Has Variables",
    brief: "The engineering choices that made a lunar landing possible.",
    episodeTitle: "A Computer With No Room to Spare",
    episodeBrief: "How the guidance computer fit the mission inside severe limits.",
    episodeFocus: "the Apollo Guidance Computer",
    episodeNumber: 1,
    seriesId: "series_apollo",
    episodeId: "episode_guidance",
    createdAt: "2026-08-12T09:30:00.000Z",
  });
  const next = nextEpisodeDefinition(series, {
    episodeTitle: "The Descent Engine's One Shot",
    episodeBrief: "Why the lunar module needed a throttleable engine.",
    episodeFocus: "the lunar module descent engine",
    // A generated episode cannot rename or reclassify the saved series.
    title: "A Different Podcast",
    about: "Mars",
  });

  for (const field of [
    "about", "episodes", "angle", "title", "brief", "presetId", "seriesId",
    "createdAt", "freshness", "useWire",
  ]) {
    assert.deepEqual(next[field], series[field], `${field} changed while advancing the episode`);
  }
  assert.equal(next.episodeNumber, 2);
  assert.equal(next.episodeTitle, "The Descent Engine's One Shot");
  assert.equal(next.episodeFocus, "the lunar module descent engine");
  assert.notEqual(next.episodeId, series.episodeId);
  assert.deepEqual(next.episodeHistory.at(-1), {
    episodeId: series.episodeId,
    episodeNumber: series.episodeNumber,
    episodeTitle: series.episodeTitle,
    episodeBrief: series.episodeBrief,
    episodeFocus: series.episodeFocus,
  });

  const duplicate = nextEpisodeDefinition(series, { episodeFocus: series.episodeFocus });
  assert.notEqual(duplicate.episodeFocus.toLowerCase(), series.episodeFocus.toLowerCase());
  assert.notEqual(duplicate.episodeId, series.episodeId);
});

test("research always anchors a poetic episode facet to the series subject", async () => {
  const { episodeResearchSubject } = await import("../src/showdef.js");
  const show = defineShow({
    about: "the Apollo moon landing",
    title: "Needles in a Moving Sky",
    episodeTitle: "Where Are We?",
    episodeFocus: "how they calculated where they were, before deciding where to go",
  });
  assert.equal(
    episodeResearchSubject(show),
    "the Apollo moon landing: how they calculated where they were, before deciding where to go",
  );
});

test("a subject is identified by its words, not its punctuation", () => {
  assert.equal(topicKey("Voyager 1: still talking"), topicKey("voyager 1 — still talking"));
  assert.notEqual(topicKey("Voyager 1"), topicKey("Voyager 2"));
});

/* ---------- incremental script reader ---------- */

test("TurnExtractor emits turns before the JSON is closed", () => {
  const x = new TurnExtractor();
  assert.deepEqual(x.push('{"turns":[{"speaker":"ari",'), []);
  const first = x.push('"text":"Line one."},{"speaker":"dev","text":"Line two."}');
  assert.equal(first.length, 2);
  assert.equal(first[0].text, "Line one.");
  assert.equal(first[1].speaker, "dev");
  assert.deepEqual(x.push(',{"speaker":"ari","text":"Three."}'), [{ speaker: "ari", text: "Three." }]);
});

test("TurnExtractor survives braces and escapes inside text", () => {
  const x = new TurnExtractor();
  const out = x.push('{"turns":[{"speaker":"ari","text":"He said \\"it\\u2019s {fine}\\" and left."}]');
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'He said "it’s {fine}" and left.');
});

test("TurnExtractor reads dialogue even when the plan is emitted first", () => {
  // These responses carry a plan and two interest arrays. Anchoring on the first
  // `[` in the buffer would read plan items as dialogue and emit nothing sayable.
  const x = new TurnExtractor();
  const out = x.push(
    '{"plan":[{"title":"Voyager","query":"voyager 1 power budget","why":"it fits"}],' +
      '"turns":[{"speaker":"ari","text":"Still transmitting."}]',
  );
  assert.equal(out.length, 1, `expected the one real turn, got ${JSON.stringify(out)}`);
  assert.equal(out[0].text, "Still transmitting.");
});

test("TurnExtractor stops at the end of the dialogue array", () => {
  const x = new TurnExtractor();
  x.push('{"turns":[{"speaker":"ari","text":"One."}],');
  const after = x.push('"plan":[{"title":"T","query":"q","why":"w"}]}');
  assert.deepEqual(after, [], "plan items leaked into the spoken script");
});

test("TurnExtractor final() recovers the whole payload", () => {
  const x = new TurnExtractor();
  x.push('{"turns":[{"speaker":"ari","text":"A."}],"plan":[{"title":"T","query":"q","why":"w"}]}');
  const final = x.final();
  assert.equal(final.turns.length, 1);
  assert.equal(final.plan[0].title, "T");
});

test("Sam can stream one producer question without becoming a third host", async () => {
  const x = new TurnExtractor();
  const first = x.push(
    '{"turns":[{"speaker":"ari","text":"The mechanism starts here."},' +
      '{"speaker":"producer","text":"Sam asks what evidence separates those explanations."},',
  );
  assert.deepEqual(first.map((turn) => turn.speaker), ["ari", "producer"]);
  const second = x.push(
    '{"speaker":"producer","text":"Sam tries to take another turn."},' +
      '{"speaker":"dev","text":"The consequence is narrower than it sounds."}]}',
  );
  assert.deepEqual(second.map((turn) => turn.speaker), ["dev"]);
  assert.deepEqual(x.final().turns.map((turn) => turn.speaker), ["ari", "producer", "dev"]);

  const { config } = await import("../src/config.js");
  assert.equal(config.hosts.producer.name, "Sam");
  assert.ok(config.hosts.producer.voice && config.hosts.producer.delivery);
});

/* ---------- call-in query building ---------- */

test("a named subject becomes a phrase-quoted subject query", () => {
  const q = queryForQuestion("What is going on with Bank of America right now?");
  assert.equal(q.subject, "Bank of America");
  assert.equal(q.q, undefined, "a subject query must not also send q");
});

test("a leading capital that is only a sentence start is not a subject", () => {
  assert.equal(queryForQuestion("What is happening today?"), null);
});

test("a question with no named subject spends no wire call", () => {
  assert.equal(queryForQuestion("can you talk about something happier please"), null);
});

test("characters the query grammar forbids never reach a query value", () => {
  const q = queryForQuestion("any news on Tesla/SpaceX [today]?");
  assert.ok(q, "expected a query");
  for (const value of Object.values(q)) {
    assert.equal(/[[\]/\\:^]/.test(value), false, `forbidden character in ${value}`);
  }
  // The slash must split the two names, not weld them into one dead phrase.
  assert.equal(/tesla\s+spacex/i.test(q.subject ?? ""), false, `welded phrase: ${q.subject}`);
});

/* ---------- web research post-processing ---------- */

test("inline citation markers are stripped before text-to-speech", () => {
  const raw =
    "Five workers died. ([theguardian.com](https://x.com/a?utm_source=openai)) " +
    "The NTSB is investigating ([apnews.com](https://y.com/b), [reuters.com](https://z.com/c)).";
  const clean = stripInlineCitations(raw);
  assert.equal(clean.includes("http"), false, clean);
  assert.equal(clean.includes("]("), false, clean);
  assert.ok(clean.startsWith("Five workers died."), clean);
  assert.ok(clean.includes("The NTSB is investigating"), clean);
});

test("a bare markdown link keeps its label", () => {
  assert.equal(stripInlineCitations("see [the report](https://x.com)"), "see the report");
});

/* ---------- wire parsing ---------- */

test("zone-less wire timestamps are read as UTC, not local", () => {
  const parsed = parseWireTime("2026-09-08T18:17:05");
  assert.equal(parsed.toISOString(), "2026-09-08T18:17:05.000Z");
});

test("an explicit zone on a wire timestamp is respected", () => {
  assert.equal(parseWireTime("2026-09-08T18:17:05Z").toISOString(), "2026-09-08T18:17:05.000Z");
  assert.equal(parseWireTime("2026-09-08T11:17:05-07:00").toISOString(), "2026-09-08T18:17:05.000Z");
});

test("story identity survives the provider reissuing an event id", () => {
  const a = { event_id: "evt_one", headline: "Cargo Plane Crashes in Miami", entities: [{ name: "Amazon" }] };
  const b = { event_id: "evt_TWO_after_fold", headline: "Cargo plane crashes in Miami!", entities: [{ name: "Amazon" }] };
  assert.equal(storyKey(a), storyKey(b), "the same story got two identities");
  const other = { event_id: "evt_three", headline: "Bank merger clears review", entities: [] };
  assert.notEqual(storyKey(a), storyKey(other), "different stories collided");
});

/* ---------- freeform label matching ---------- */

test("a freeform topic reaches the wire's compound taxonomy label", () => {
  const story = { sector: "sports_recreation", eventType: "sports.match_result", headline: "Sabalenka advances", entities: [] };
  assert.ok(labelWeight("sports", story) > 0, "'sports' did not reach sports_recreation");
  assert.equal(labelWeight("banking", story), 0, "an unrelated topic matched");
});

test("an exact taxonomy hit outranks a word inside a compound label", () => {
  const story = { sector: "sports_recreation", eventType: "sports.match_result", headline: "x", entities: [] };
  assert.equal(labelWeight("sports_recreation", story), 1);
  assert.ok(labelWeight("recreation", story) < 1, "a word inside a compound scored as an exact hit");
  assert.ok(labelWeight("recreation", story) > 0, "a word inside a compound did not match at all");
});

test("matching is on whole words, not substrings", () => {
  assert.equal(phraseMatches("port", "Reporting on the airport"), false, "matched inside a longer word");
  assert.ok(phraseMatches("port", "The port of Oakland"));
  assert.equal(normalizeText("deals.merger_acquisition"), "deals merger acquisition");
});

test("short explicit interests still match", () => {
  assert.ok(phraseMatches("AI", "New AI rules land in Brussels"));
  assert.ok(phraseMatches("UK", "The UK budget"));
  assert.equal(phraseMatches("AI", "She said it plainly"), false);
  assert.equal(phraseMatches("US", "A bus route closed"), false);
});

test("a muted freeform label vetoes the compound-labelled story", async () => {
  const store = new ProfileStore();
  await store.setPreference("veto", "sports", "less");
  const profile = await store.load("veto");
  const sport = store.affinity(profile, {
    sector: "sports_recreation",
    eventType: "sports.match_result",
    headline: "Semifinal decided in three sets",
    entities: [],
  });
  const other = store.affinity(profile, {
    sector: "banking",
    eventType: "deals.merger_acquisition",
    headline: "Merger clears review",
    entities: [],
  });
  assert.ok(sport < other - 5, `mute did not change ranking: ${sport} vs ${other}`);
});

test('"less sports" lowers the score instead of learning sports', async () => {
  const store = new ProfileStore();
  await store.setPreference("pref", "sports", "less");
  const profile = await store.load("pref");
  const topic = store.interests(profile).topics.find((t) => t.label === "sports");
  assert.ok(topic, "the label was not recorded at all");
  assert.ok(topic.score < 0, `expected a negative score, got ${topic.score}`);
  assert.ok(profile.muted.includes("sports"), "the label was not muted");
  assert.equal(topic.source, "preference");
});

test('"more X" pins it and clears any mute', async () => {
  const store = new ProfileStore();
  await store.setPreference("pref2", "local politics", "less");
  await store.setPreference("pref2", "local politics", "more");
  const profile = await store.load("pref2");
  assert.equal(profile.muted.includes("local politics"), false);
  assert.ok(store.interests(profile).topics[0].score > 0);
});

/* ---------- bounded waits ---------- */

test("fetchWithTimeout aborts a hung upstream", async () => {
  const http = await import("node:http");
  const server = http.createServer(() => {
    /* accept the socket and never answer */
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const started = Date.now();
  await assert.rejects(
    () => fetchWithTimeout(`http://127.0.0.1:${port}/`, {}, 300),
    (err) => err.code === "TIMEOUT",
  );
  assert.ok(Date.now() - started < 2000, "timeout did not fire promptly");
  server.close();
});

test("the deadline covers the body, not just the headers", async () => {
  const http = await import("node:http");
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain", "transfer-encoding": "chunked" });
    res.write("partial"); // headers land, body never completes
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const started = Date.now();
  const res = await fetchWithTimeout(`http://127.0.0.1:${port}/`, {}, 400);
  assert.equal(res.ok, true, "headers should have arrived fine");
  await assert.rejects(
    () => readBody(res, "text"),
    (err) => err.code === "TIMEOUT",
    "a stalled body read was not bounded",
  );
  assert.ok(Date.now() - started < 3000, "the body read was not cut off promptly");
  server.close();
});

test("a caller signal that is already aborted is not reported as a timeout", async () => {
  const http = await import("node:http");
  const server = http.createServer((req, res) => res.end("ok"));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  await assert.rejects(
    () => fetchWithTimeout(`http://127.0.0.1:${port}/`, { signal: AbortSignal.abort() }, 5000),
    (err) => err.code !== "TIMEOUT",
    "caller cancellation was mislabelled as a timeout",
  );
  server.close();
});

test("withDeadline falls back rather than hanging", async () => {
  const never = new Promise(() => {});
  assert.equal(await withDeadline(never, 100, "fallback"), "fallback");
  assert.equal(await withDeadline(Promise.reject(new Error("x")), 100, "fallback"), "fallback");
});

test("Ari and Dev start independent research lanes with their provenance intact", async () => {
  const { researchForHosts } = await import("../src/research.js");
  const calls = [];
  let release;
  const bothStarted = new Promise((resolve) => { release = resolve; });
  const researcher = async (input) => {
    calls.push(input);
    if (calls.length === 2) release();
    await bothStarted;
    return {
      laneMarker: input.lane,
      usable: true,
      sources: [{ url: `https://${input.lane}.example/report`, name: `${input.lane} desk` }],
    };
  };

  const result = await researchForHosts(
    {
      query: "Apollo lunar module engineering",
      subject: "the lunar module",
      context: "the shared episode focus only",
      show: { freshness: null, families: ["reference"] },
      useWire: true,
    },
    { researcher, deadlineMs: 250 },
  );

  assert.deepEqual(calls.map((call) => call.lane).sort(), ["ari", "dev"]);
  assert.equal(calls[0].signal, calls[1].signal, "the lanes were given separate wall clocks");
  assert.equal(calls[0].deadlineMs, calls[1].deadlineMs);
  assert.ok(calls[0].deadlineMs < 250, "the inner collectors have no room to settle before the outer deadline");
  assert.notEqual(calls[0].researchAngle, calls[1].researchAngle);
  assert.ok(calls.every((call) => call.context === "the shared episode focus only"));
  assert.equal(calls.find((call) => call.lane === "ari").useWire, true);
  assert.equal(calls.find((call) => call.lane === "dev").useWire, false);
  assert.deepEqual(result.packets.map((packet) => packet.speaker), ["ari", "dev"]);
  for (const packet of result.packets) {
    assert.equal(packet.status, "ready");
    assert.equal(packet.research.laneMarker, packet.speaker);
    assert.equal(packet.sources[0].url, `https://${packet.speaker}.example/report`);
  }
  assert.deepEqual(
    result.sources.map((source) => source.url).sort(),
    ["https://ari.example/report", "https://dev.example/report"],
  );
});

test("the shared research deadline preserves a usable lane when its peer hangs", async () => {
  const { researchForHosts } = await import("../src/research.js");
  const signals = [];
  const researcher = ({ lane, signal }) => {
    signals.push(signal);
    if (lane === "dev") return new Promise(() => {});
    return new Promise((resolve) => setTimeout(() => resolve({
      usable: true,
      sources: [{ url: "https://ari.example/finished" }],
    }), 15));
  };
  const wallStarted = Date.now();
  const result = await researchForHosts(
    { query: "q", subject: "s", show: {} },
    { researcher, deadlineMs: 80 },
  );
  const wallElapsed = Date.now() - wallStarted;

  assert.ok(result.elapsedMs >= 50 && result.elapsedMs < 300, `shared deadline elapsed in ${result.elapsedMs}ms`);
  assert.ok(wallElapsed < 300, `the hanging lane held the caller for ${wallElapsed}ms`);
  assert.equal(signals[0], signals[1]);
  assert.equal(signals[0].aborted, true, "the timed-out work kept running");
  assert.equal(result.usable, true);
  assert.equal(result.packets.find((packet) => packet.speaker === "ari").status, "ready");
  assert.equal(result.packets.find((packet) => packet.speaker === "dev").status, "timed_out");
  assert.deepEqual(result.sources.map((source) => source.url), ["https://ari.example/finished"]);
});

test("aborting the parent research request promptly retires both lanes", async () => {
  const { researchForHosts } = await import("../src/research.js");
  const parent = new AbortController();
  const laneSignals = [];
  const researcher = ({ lane, signal }) => {
    laneSignals.push(signal);
    if (lane === "ari") return Promise.resolve({ usable: true, sources: [{ url: "https://ari.example/a" }] });
    return new Promise(() => {});
  };
  const started = Date.now();
  const job = researchForHosts(
    { query: "q", subject: "s", show: {}, signal: parent.signal },
    { researcher, deadlineMs: 500 },
  );
  setTimeout(() => parent.abort(new Error("episode changed")), 20);
  const result = await job;

  assert.ok(Date.now() - started < 250, "parent cancellation waited for the research deadline");
  assert.ok(laneSignals.length === 2 && laneSignals.every((signal) => signal.aborted));
  assert.equal(result.packets.find((packet) => packet.speaker === "ari").status, "ready");
  assert.equal(result.packets.find((packet) => packet.speaker === "dev").status, "timed_out");
});

/* ---------- the showrunner ---------- */

/** A show that is already running, without touching the network. */
async function runningShow(id, over = {}) {
  const { showFor } = await import("../src/show.js");
  const show = showFor(id);
  show.def = defineShow({ about: "test subjects", episodes: "one at a time", angle: "plainly" });
  show.started = true;
  show.planned = Promise.resolve([]);
  show.building = Promise.resolve(); // keep the lookahead builder out of the way
  Object.assign(show, over);
  return show;
}

function fakeSegment(over = {}) {
  return {
    id: `seg_${Math.random().toString(16).slice(2)}`,
    kind: "topic",
    title: "A subject",
    why: "",
    planItem: null,
    sources: [],
    coverKeys: [],
    turns: [{ text: "one" }, { text: "two" }, { text: "three" }],
    complete: true,
    cancelled: false,
    abandoned: false,
    aired: false,
    airedThrough: -1,
    waitForTurn: async () => {},
    cancel() {
      this.cancelled = true;
      this.complete = true;
    },
    abandon() {
      this.abandoned = true;
    },
    addTurn() {},
    finish() {
      this.complete = true;
    },
    ...over,
  };
}

test("show.js evaluates and exposes its call path", async () => {
  const mod = await import("../src/show.js");
  assert.equal(typeof mod.showFor, "function");
  const show = mod.showFor("wiring-check");
  assert.equal(typeof show.submitCall, "function");
  assert.equal(typeof show.queueCall, "function");
  assert.equal(typeof show.reportProgress, "function");
});

test("progress phases: only a finished line counts as heard", async () => {
  const show = await runningShow("phases", { started: false });
  const segment = fakeSegment({ coverKeys: ["tk_test"], title: "Test subject" });
  show.segments.push(segment);
  show.deliveredThrough = 0;

  show.reportProgress({ segmentId: segment.id, turnIndex: 0, phase: "started" });
  assert.equal(segment.airedThrough, -1, "a started line moved the resume point");
  assert.equal(segment.aired, false, "a started line was counted as heard");
  assert.equal(show.onAir.turnIndex, 0, "a started line did not move what is on air");

  show.reportProgress({ segmentId: segment.id, turnIndex: 0, phase: "finished" });
  assert.equal(segment.airedThrough, 0, "a finished line did not move the resume point");
  assert.equal(segment.aired, true, "a finished line was not counted as heard");
  assert.ok(show.covered.includes("Test subject"), "an aired subject was not recorded as covered");

  const before = segment.aired;
  show.reportProgress({ segmentId: segment.id, turnIndex: 1, phase: "skipped" });
  assert.equal(segment.airedThrough, 1, "a skipped line wedged the resume point");
  assert.equal(segment.aired, before, "a skipped line changed the heard flag");

  show.reportProgress({ segmentId: segment.id, turnIndex: 2 });
  assert.equal(segment.airedThrough, 2);
});

test("episode memory contains heard and committed work, never stale queued work", async () => {
  const show = await runningShow("memory-budget");
  const heard = fakeSegment({
    title: "Heard subject",
    turns: Array.from({ length: 25 }, (_, index) => ({
      speaker: index % 2 ? "dev" : "ari",
      text: `Heard fact ${index + 1}`,
    })),
  });
  const committed = fakeSegment({
    title: "Committed subject",
    turns: Array.from({ length: 12 }, (_, index) => ({
      speaker: index % 2 ? "dev" : "ari",
      text: `Committed fact ${index + 1}`,
    })),
  });
  const cancelled = fakeSegment({ turns: [{ speaker: "ari", text: "Cancelled future fact" }] });
  const staleQueued = fakeSegment({ turns: [{ speaker: "dev", text: "Stale queued future fact" }] });
  const target = fakeSegment({ turns: [] });
  show.segments.push(heard, committed, cancelled, staleQueued, target);

  for (let index = 0; index < heard.turns.length; index++) {
    show.reportProgress({ segmentId: heard.id, turnIndex: index, phase: "finished" });
  }
  // The client received `committed` and `cancelled`; staleQueued is still only a
  // speculative lookahead. Cancellation takes the former out of continuity too.
  show.deliveredThrough = 2;
  cancelled.cancel();

  const memory = show.memoryContext(target);
  assert.equal(memory.heard.length, 18);
  assert.equal(memory.heard[0], "Heard fact 8");
  assert.equal(memory.heard.at(-1), "Heard fact 25");
  assert.equal(memory.committed.length, 10);
  assert.equal(memory.committed[0], "Committed fact 3");
  assert.equal(memory.committed.at(-1), "Committed fact 12");
  const promptMemory = [...memory.heard, ...memory.committed].join(" | ");
  assert.equal(promptMemory.includes("Cancelled future fact"), false);
  assert.equal(promptMemory.includes("Stale queued future fact"), false);

  show.reset();
  assert.deepEqual(show.memoryContext(), { heard: [], committed: [] });
});

test("a reconnect mid-line replays that line rather than skipping it", async () => {
  const show = await runningShow("replay");
  const segment = fakeSegment({ turns: [{ text: "one" }, { text: "two" }] });
  show.segments.push(segment);
  show.deliveredThrough = 0;

  show.reportProgress({ segmentId: segment.id, turnIndex: 0, phase: "finished" });
  show.reportProgress({ segmentId: segment.id, turnIndex: 1, phase: "started" });
  const next = await show.next({ timeoutMs: 500 });
  assert.equal(next.segment.id, segment.id, "the half-played segment was abandoned");
  assert.equal(next.resumeFrom, 1, `expected to replay turn 1, got ${next.resumeFrom}`);
});

test("the tap lights the board without disturbing what is on air", async () => {
  // The microphone permission prompt is up at this point. The hosts must keep
  // talking through it, and nothing may cue the listener to start speaking.
  const show = await runningShow("board");
  const segment = fakeSegment();
  show.segments.push(segment);
  show.deliveredThrough = 0;
  show.reportProgress({ segmentId: segment.id, turnIndex: 0, phase: "finished" });

  const { call, jumpTo } = show.queueCall();
  assert.equal(call.status, "queued");
  assert.equal(jumpTo, null, "the invitation aired before there was a recorder for it");
  assert.equal(segment.abandoned, false, "the hosts were cut off while permission was pending");
  assert.equal(show.segments.length, 1, "a segment was queued at the tap");
});

test("the invitation is a separate step, behind the line on air", async () => {
  const show = await runningShow("invite");
  const segment = fakeSegment();
  show.segments.push(segment);
  show.deliveredThrough = 0;
  show.reportProgress({ segmentId: segment.id, turnIndex: 0, phase: "finished" });
  show.queueCall();

  const { call, jumpTo } = show.inviteCaller();
  assert.equal(call.status, "inviting");
  const bridge = show.segment(jumpTo);
  assert.equal(bridge.bridgeRole, "handoff", "the caller was never invited in");
  assert.ok(bridge.complete && bridge.turns.length >= 1, "the invitation was not ready instantly");
  assert.match(bridge.turns[0].text, /caller/i);
  assert.ok(segment.abandoned, "the segment on air kept going after the hosts handed over");
  assert.equal(show.segments.indexOf(bridge), show.segments.indexOf(segment) + 1);

  // Inviting twice must reuse the one invitation, not stack another on the air.
  assert.equal(show.inviteCaller().jumpTo, jumpTo);
  assert.equal(show.segments.filter((x) => x.bridgeRole === "handoff").length, 1);
});

test("a second tap re-uses the call already on the board", async () => {
  const show = await runningShow("doubletap");
  show.segments.push(fakeSegment());
  show.deliveredThrough = 0;
  const first = show.queueCall();
  const second = show.queueCall();
  assert.equal(second.call.id, first.call.id, "a double tap opened a second call");
  assert.equal(second.jumpTo, first.jumpTo);
  assert.equal(second.resumed, true);
});

test("what was on air is snapshotted at the tap, not read back after the invitation", async () => {
  const show = await runningShow("pronouns");
  const segment = fakeSegment({ title: "The Voyager 1 power budget" });
  show.segments.push(segment);
  show.deliveredThrough = 0;
  show.reportProgress({ segmentId: segment.id, turnIndex: 0, phase: "finished" });

  const { call } = show.queueCall();
  assert.match(call.context, /Voyager 1/, "the tap did not capture what was on air");

  // The invitation now airs, and `onAir` becomes "Caller, you're on" — which is what
  // a caller's "what about that?" would otherwise be resolved against.
  const bridge = show.segment(show.inviteCaller().jumpTo);
  bridge.waitForTurn = async () => {};
  show.reportProgress({ segmentId: bridge.id, turnIndex: 0, phase: "finished" });
  assert.equal(/Voyager/.test(show.context()), false, "the test's premise no longer holds");
  assert.match(call.context, /Voyager 1/, "the snapshot was overwritten by the invitation");
  assert.match(call.recap, /Voyager 1/);
});

test("hanging up before the invitation airs leaves no trace", async () => {
  const show = await runningShow("hangup-early");
  show.segments.push(fakeSegment());
  show.deliveredThrough = 0;
  show.queueCall();
  const { jumpTo } = show.inviteCaller();
  const result = show.cancelCall();
  assert.equal(result.jumpTo, null, "the hosts explained a caller nobody had heard announced");
  assert.equal(show.segment(jumpTo).cancelled, true, "the unaired invitation was left queued");
  assert.equal(show.call.status, "cancelled");
});

test("hanging up after the invitation aired is explained on air", async () => {
  const show = await runningShow("hangup-late");
  show.segments.push(fakeSegment());
  show.deliveredThrough = 0;
  show.queueCall();
  const { jumpTo } = show.inviteCaller();
  const bridge = show.segment(jumpTo);
  bridge.waitForTurn = async () => {};
  show.reportProgress({ segmentId: bridge.id, turnIndex: 0, phase: "finished" });

  const result = show.cancelCall({ reason: "denied" });
  const notice = show.segment(result.jumpTo);
  assert.equal(notice.bridgeRole, "dropped");
  assert.match(notice.turns[0].text, /lost|gone/i);
});

test("a caller cannot submit the same question twice", async () => {
  const show = await runningShow("double-submit");
  show.segments.push(fakeSegment());
  show.deliveredThrough = 0;
  show.queueCall();
  show.call.status = "researching"; // as if a submit is already in flight
  await assert.rejects(
    () => show.submitCall({ question: "again?" }),
    (err) => err.status === 409 && err.code === "CALL_ALREADY_SUBMITTED",
  );
});

test("tapping again while the hosts are still answering is refused", async () => {
  // Otherwise the second tap replays the old invitation over an answer that is
  // still being written, and the submit behind it collides with the first.
  const show = await runningShow("tap-during-answer");
  show.segments.push(fakeSegment());
  show.deliveredThrough = 0;
  show.queueCall();
  show.call.status = "researching";
  assert.throws(
    () => show.queueCall(),
    (err) => err.status === 409 && err.code === "CALL_IN_PROGRESS",
  );
});

test("nothing is built from the old plan while a caller is on the board", async () => {
  const show = await runningShow("no-wasted-build", { building: null });
  show.segments.push(fakeSegment());
  show.deliveredThrough = 0;
  show.plan = [{ title: "Old subject", query: "old", why: "" }];
  show.queueCall();
  show.inviteCaller();

  // The invitation is queued, so the delivery cursor is behind it and the lookahead
  // would normally fire. It must not: this plan is about to be replaced.
  await show.next({ timeoutMs: 300 }).catch(() => {});
  assert.equal(show.building, null, "a segment was researched for an episode about to change");
  assert.deepEqual(show.plan.map((p) => p.title), ["Old subject"], "the old plan was consumed");
});

test("a dropped lookahead puts its subject back on the plan", async () => {
  const show = await runningShow("restore");
  const onAir = fakeSegment({ title: "First" });
  const queued = fakeSegment({ title: "Second", planItem: { title: "Second", query: "q", why: "" } });
  show.segments.push(onAir, queued);
  show.deliveredThrough = 1;
  show.reportProgress({ segmentId: onAir.id, turnIndex: 0, phase: "finished" });

  show.queueCall();
  show.inviteCaller();
  assert.ok(queued.cancelled, "a segment nobody heard survived the interruption");
  assert.deepEqual(show.plan.map((p) => p.title), ["Second"], "its subject was lost from the episode");
});

test("'hurry up' shortens the pace and never learns a dislike", async () => {
  const show = await runningShow("hurry");
  const segment = fakeSegment({ title: "A long one about Testa McPlaceholder" });
  show.segments.push(segment);
  show.deliveredThrough = 0;

  const result = await show.hurry(segment.id);
  assert.ok(segment.abandoned, "the segment kept going");
  assert.equal(result.pacing, -1);
  const { profiles } = await import("../src/profile.js");
  const profile = await profiles.load("hurry");
  assert.deepEqual(Object.keys(profile.entities), [], "hurrying taught the profile a dislike");
});

test("'dive deeper' queues a second pass at the same subject, next", async () => {
  const show = await runningShow("deeper", { building: Promise.resolve() });
  const onAir = fakeSegment({ title: "Voyager 1" });
  const queued = fakeSegment({ title: "Something else", planItem: { title: "Something else", query: "q", why: "" } });
  show.segments.push(onAir, queued);
  show.deliveredThrough = 1;
  show.reportProgress({ segmentId: onAir.id, turnIndex: 0, phase: "finished" });

  const result = await show.deeper(onAir.id);
  assert.equal(result.pacing, 1);
  assert.equal(onAir.abandoned, false, "going deeper cut off the segment it was deepening");
  assert.equal(show.plan[0].title, "Voyager 1 — further in");
  assert.match(show.plan[0].query, /Voyager 1/);
  assert.equal(show.plan[1].title, "Something else", "the displaced subject was dropped");
});

test("the handoff counts as a call in flight", async () => {
  // The gap this closes: during the handoff the plan is one question away from
  // being replaced, and a build started here produced the same subject twice.
  const show = await runningShow("inviting-gate", { building: null });
  show.segments.push(fakeSegment());
  show.deliveredThrough = 0;
  show.plan = [{ title: "Old subject", query: "old", why: "" }];
  show.queueCall();
  show.inviteCaller();
  assert.equal(show.call.status, "inviting");

  show.ensureLookahead();
  assert.equal(show.building, null, "a segment was built during the handoff");
  assert.deepEqual(show.plan.map((p) => p.title), ["Old subject"]);
});

test("hanging up mid-research takes the hold line down with it", async () => {
  const show = await runningShow("cancel-research");
  const onAir = fakeSegment();
  show.segments.push(onAir);
  show.deliveredThrough = 0;
  show.reportProgress({ segmentId: onAir.id, turnIndex: 0, phase: "finished" });
  show.queueCall();
  const { jumpTo } = show.inviteCaller();
  const invitation = show.segment(jumpTo);
  invitation.waitForTurn = async () => {};
  show.reportProgress({ segmentId: invitation.id, turnIndex: 0, phase: "finished" });

  // As submitCall leaves things while the answer is being written.
  const hold = fakeSegment({ kind: "bridge", bridgeRole: "hold", title: "Looking that up" });
  const answer = fakeSegment({ kind: "caller", title: "a question" });
  show.segments.push(hold, answer);
  show.call.status = "researching";
  show.call.holdId = hold.id;
  show.call.segmentId = answer.id;

  const result = show.cancelCall();
  assert.equal(show.segment(result.jumpTo).bridgeRole, "dropped");
  assert.ok(hold.cancelled, "'let me pull that up' was left queued for a caller who hung up");
  assert.ok(answer.cancelled, "the answer to a dropped caller survived");
});

test("a cancelled call's answer never rewrites the profile or the plan", async () => {
  const show = await runningShow("cancel-late");
  show.plan = [{ title: "Planned", query: "q", why: "" }];
  show.call = { id: "c1", status: "cancelled", segmentId: null };
  await show.learnFromCall(
    { plan: [{ title: "From the call", query: "q", why: "" }], interests: { topics: ["x"], entities: [] }, preferences: [] },
    "a question",
    show.planGeneration,
  );
  assert.deepEqual(show.plan.map((p) => p.title), ["Planned"], "a dropped call re-planned the episode");
  const { profiles } = await import("../src/profile.js");
  const profile = await profiles.load("cancel-late");
  assert.deepEqual(Object.keys(profile.topics), [], "a dropped call taught the profile something");
});

test("the answer survives re-planning while the hold line is still on air", async () => {
  // The regression this is here for: re-planning after the answer came back used
  // to cut the queue at whatever was on air. If playback is slow or paused, that
  // is the hold bridge — which sits in *front* of the answer — so the cut
  // cancelled the very answer it had just finished writing.
  const { showFor } = await import("../src/show.js");
  const show = await runningShow("answer-survives");
  const hold = fakeSegment({ kind: "bridge", bridgeRole: "hold", title: "Looking that up" });
  const answer = fakeSegment({ kind: "caller", title: "the caller's question" });
  show.segments.push(hold, answer);
  show.deliveredThrough = 1;
  // The listener is still hearing the hold line: `onAir` is behind the answer.
  show.reportProgress({ segmentId: hold.id, turnIndex: 0, phase: "finished" });
  assert.equal(show.onAir.segmentId, hold.id, "the test's premise no longer holds");

  show.call = { id: "call_x", status: "researching", segmentId: answer.id };
  await show.learnFromCall(
    { plan: [{ title: "New direction", query: "q", why: "w" }], interests: { topics: [], entities: [] }, preferences: [] },
    "what about Voyager?",
    show.planGeneration,
  );

  assert.equal(answer.cancelled, false, "re-planning cancelled the caller's own answer");
  assert.equal(answer.abandoned, false, "the caller's answer was cut short");
  assert.deepEqual(show.plan.map((p) => p.title), ["New direction"], "the plan was not replaced");
  assert.equal(showFor("answer-survives"), show);
});

test("a build that finishes after a reset does not open the gate for a duplicate", async () => {
  // A reset lands while a segment is being built. If the old job's `finally`
  // clears the slot unconditionally, its late completion frees the slot that the
  // post-reset build is holding, and the next lookahead starts a second build of
  // the same subject.
  const show = await runningShow("build-race", { building: null });
  const releases = [];
  let builds = 0;
  show.buildNextSegment = () => {
    builds += 1;
    return new Promise((resolve) => releases.push(resolve));
  };

  show.ensureLookahead();
  assert.equal(builds, 1, "the first build did not start");
  const stale = show.building;

  show.reset();
  show.started = true; // as the fresh episode would be, a moment later
  show.ensureLookahead();
  assert.equal(builds, 2, "the post-reset build did not start");
  const current = show.building;
  assert.notEqual(current, stale);

  // The old job now finishes, long after the episode it belonged to.
  releases[0]();
  await stale;
  assert.equal(show.building, current, "a finished stale build freed the live build's slot");

  show.ensureLookahead();
  assert.equal(builds, 2, "a duplicate build started for the same segment");
  releases[1]();
  await current;
  assert.equal(show.building, null, "the live build never released its slot");
});

test("an interrupted start never marks the torn-down episode as started", async () => {
  const show = await runningShow("start-race", { started: false, starting: null });
  show.def = null; // force start() down the definition path
  const attempt = show.start().catch(() => {});
  show.reset(); // the premise changes mid-start
  await attempt;
  assert.equal(show.started, false, "a torn-down episode was marked started");
});

test("a new episode voids everything queued for the old one", async () => {
  const show = await runningShow("reset");
  const segment = fakeSegment();
  show.segments.push(segment);
  show.deliveredThrough = 0;
  show.plan = [{ title: "Old", query: "q", why: "" }];
  show.queueCall();
  show.inviteCaller();
  const generation = show.planGeneration;

  show.reset();
  assert.ok(show.planGeneration > generation, "the generation did not move");
  assert.deepEqual(show.segments, []);
  assert.deepEqual(show.plan, []);
  assert.equal(show.call, null, "a call survived the premise changing");
  assert.equal(show.started, false);
  assert.ok(segment.cancelled, "an old segment was left playable");
});

test("a reset while the next facet is being derived cannot overwrite or start it", async () => {
  const { showFor } = await import("../src/show.js");
  const show = showFor("stale-next-episode");
  const original = defineShow({
    about: "the Apollo moon landing",
    title: "The Eagle Has Variables",
    episodeTitle: "The Guidance Computer",
    episodeFocus: "the Apollo Guidance Computer",
  });
  await show.define(original);

  let releaseDerive;
  let deriveStarted;
  const started = new Promise((resolve) => { deriveStarted = resolve; });
  let starts = 0;
  const job = show.newEpisode({
    derive: async () => {
      deriveStarted();
      return new Promise((resolve) => { releaseDerive = resolve; });
    },
    start: async () => { starts += 1; },
  });
  await started;
  show.reset();
  releaseDerive({
    episodeTitle: "The Descent Engine",
    episodeBrief: "A late result that belongs to the cancelled request.",
    episodeFocus: "the lunar module descent engine",
  });

  await assert.rejects(job, (err) => err.code === "STALE_EPISODE");
  assert.equal(show.def, original, "a cancelled next-episode request replaced the live definition");
  assert.equal(starts, 0, "a cancelled next-episode request started playing");
});

test("the latest overlapping podcast definition owns memory, scope, and disk", async () => {
  const { showFor } = await import("../src/show.js");
  const { showScope } = await import("../src/showdef.js");
  const listenerId = "overlapping-definitions";
  const show = showFor(listenerId);
  const first = defineShow({ about: "the NFL", title: "First series" });
  const latest = defineShow({ about: "Roman aqueducts", title: "Latest series" });
  const [oldResult, latestResult] = await Promise.allSettled([
    show.define(first, { researchId: "rid_old" }),
    show.define(latest, { researchId: "rid_latest" }),
  ]);

  assert.equal(oldResult.status, "rejected");
  assert.equal(oldResult.reason.code, "STALE_DEFINITION");
  assert.equal(latestResult.status, "fulfilled");
  assert.equal(show.def, latest);
  assert.equal(show.scope, showScope(latest));
  assert.deepEqual(show.headStart, { researchId: "rid_latest", generation: show.planGeneration });
  const saved = JSON.parse(
    await fs.readFile(path.join(DATA_DIR, "shows", `${listenerId}.json`), "utf8"),
  );
  assert.equal(saved.title, "Latest series");
  assert.equal(saved.about, "Roman aqueducts");
});

/* ---------- one-request setup ---------- */

test("preset setup validates its head start under the saved preset identity", async () => {
  // The route is the one non-injectable seam here. The definitions themselves are
  // exercised above; this pins the identity passed across the route boundary so a
  // curated multi-desk preset is not primed as a custom show and discarded later.
  const source = await fs.readFile(new URL("../server.js", import.meta.url), "utf8");
  const route = source.slice(source.indexOf('"/show/describe"'));
  const body = route.slice(0, route.indexOf("\n);"));
  assert.ok(
    body.includes("defineShow({ ...generatedPremise, presetId: preset?.id })"),
    "describe validates a preset under different research rules than define",
  );
});

test("a premise that comes back empty keeps the listener's own words", async () => {
  // A schema-valid but empty split would otherwise refuse a podcast someone just
  // described out loud.
  const { defineShow } = await import("../src/showdef.js");
  const said = "the deep sea and how anything survives down there";
  const show = defineShow({ about: said, episodes: "", angle: "" });
  assert.equal(show.about, said);
  assert.ok(show.episodes.length > 0, "the episode shape was left blank");
  assert.ok(show.angle.length > 0, "the angle was left blank");
});

test("working out the premise is bounded like every other upstream", async () => {
  const source = await fs.readFile(new URL("../src/llm.js", import.meta.url), "utf8");
  const fn = source.slice(source.indexOf("export async function derivePremise"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.ok(
    /timeout: config\.timeouts\.premise/.test(body),
    "the first screen the listener sees can hang forever",
  );
  const { config } = await import("../src/config.js");
  assert.ok(config.timeouts.premise > 0);
});

test("every element the client reaches for exists in the page", async () => {
  // The client is a pile of `$("id")` lookups against markup in another file, and
  // a rename on one side of that is a null dereference at runtime — usually on a
  // path nobody clicks until it matters.
  const source = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const html = await fs.readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const scanQuoted = (text, prefix) => {
    const found = new Set();
    let cursor = 0;
    for (;;) {
      const at = text.indexOf(prefix, cursor);
      if (at < 0) return found;
      const start = at + prefix.length;
      const end = text.indexOf('"', start);
      if (end < 0) return found;
      found.add(text.slice(start, end));
      cursor = end + 1;
    }
  };
  const wanted = scanQuoted(source, '$("');
  const present = scanQuoted(html, 'id="');
  const created = scanQuoted(source, '.id = "');
  const missing = [...wanted].filter((id) => !present.has(id) && !created.has(id));
  assert.deepEqual(missing, [], `the client looks up elements that are not on the page: ${missing}`);
  assert.ok(wanted.size > 20, "the id scan found almost nothing — the pattern has drifted");
});

/* ---------- the research gate ---------- */

test("Wikipedia alone is background, not evidence of what happened this week", async () => {
  const { isUsable } = await import("../src/research.js");
  const pages = [
    { title: "Association football", extract: "Football is a sport…", url: "https://en.wikipedia.org/wiki/x" },
  ];
  // A show about history can stand on an encyclopaedia. A show that claims to
  // cover the last forty-eight hours cannot.
  assert.equal(isUsable({ pages, show: { freshness: null } }), true);
  assert.equal(isUsable({ pages, show: { freshness: "the last 48 hours" } }), false);
  // Reporting counts for both.
  const reported = { summary: "AP reported on Tuesday…", sources: [{ url: "https://apnews.com/a" }] };
  assert.equal(isUsable({ summary: reported, show: { freshness: "the last 48 hours" } }), true);
  assert.equal(isUsable({ show: {} }), false, "nothing at all was treated as enough");
  assert.equal(isUsable({ summary: { summary: "   " }, show: {} }), false, "whitespace passed as reporting");
});

test("a claim with no link behind it is not evidence", async () => {
  // A summary with no citation is the model talking from memory with a search tool
  // attached — which is exactly the thing the hosts are not allowed to do, and is
  // indistinguishable from reporting by the time it reaches a script.
  const { isUsable } = await import("../src/research.js");
  const uncited = { summary: "Officials confirmed the figure on Tuesday.", sources: [] };
  assert.equal(isUsable({ summary: uncited, show: {} }), false, "an uncited claim passed as research");
  assert.equal(
    isUsable({ summary: { ...uncited, sources: [{ url: "not a url" }] }, show: {} }),
    false,
    "a malformed citation passed as research",
  );
  assert.equal(
    isUsable({ summary: { ...uncited, sources: [{ url: "javascript:alert(1)" }] }, show: {} }),
    false,
    "a non-http citation passed as research",
  );
  assert.equal(isUsable({ summary: { ...uncited, sources: [{ url: "https://apnews.com/a" }] }, show: {} }), true);
  // Same for the wire and for Wikipedia.
  assert.equal(isUsable({ events: [{ headline: "x", sources: [] }], show: {} }), false);
  assert.equal(isUsable({ pages: [{ title: "x", extract: "y" }], show: {} }), false, "a page with no link passed");
});

test("a research round reports whether it can be talked from", async () => {
  const { researchTopic } = await import("../src/research.js");
  // Both upstreams are pointed at closed ports by this suite's setup, so this is
  // the real failure path: it returns, successfully, with nothing.
  const round = await researchTopic({
    query: "anything at all",
    show: { freshness: "the last 48 hours" },
    deadlineMs: 400,
  });
  assert.equal(round.usable, false, "an empty round claimed to be usable");
  assert.equal(round.empty, true);
});

test("the show layer refuses to script a subject it has no sources for", async () => {
  // The reported failure: two searches timed out, the round returned empty, and
  // the hosts were handed the subject anyway and invented it. A prompt saying
  // "say you don't know" is not a fix — saying it convincingly and inventing the
  // answer are the same capability. The model is not called at all.
  const source = await fs.readFile(new URL("../src/show.js", import.meta.url), "utf8");

  const build = source.slice(source.indexOf("async buildNextSegment("));
  const buildBody = build.slice(0, build.indexOf("\n  async #run("));
  const gateAt = buildBody.indexOf("if (!research.usable)");
  const scriptAt = buildBody.indexOf("scriptSegment({");
  assert.ok(gateAt > 0, "a planned segment is scripted without checking for sources");
  assert.ok(gateAt < scriptAt, "the check happens after the script is already written");
  assert.ok(/NO_RESEARCH\.topic/.test(buildBody), "the fallback is generated rather than fixed");

  const submit = source.slice(source.indexOf("async submitCall("));
  const submitBody = submit.slice(0, submit.indexOf("\n  /**"));
  const callerGate = submitBody.indexOf("if (!research.usable)");
  const callerScript = submitBody.indexOf("scriptCallerSegment({");
  assert.ok(callerGate > 0 && callerGate < callerScript, "a caller can be answered without sources");
  assert.ok(/NO_RESEARCH\.caller/.test(submitBody), "the caller fallback is generated rather than fixed");
});

test("with no evidence, the hosts read the honest lines and the model is never called", async () => {
  // The behavioural proof, not a source-code assertion. Every upstream in this
  // suite is a closed port, so the research round comes back empty — exactly the
  // reported failure. If the gate holds, the segment carries the fixed lines and
  // nothing was generated. If it does not, `scriptSegment` is attempted, the
  // connection is refused, and the segment carries the error fallback instead.
  // The two are different text, so this can only pass one way.
  const { showFor } = await import("../src/show.js");
  const { defineShow } = await import("../src/showdef.js");
  const show = showFor("gate-behaviour");
  show.def = defineShow({ about: "world news", episodes: "today's stories", angle: "plain" });
  show.scope = "sc_gate";
  show.started = true;
  show.planned = Promise.resolve([]);
  show.plan = [{ title: "A subject nobody can research", query: "a subject", why: "" }];

  const segment = await show.buildNextSegment();
  assert.ok(segment, "no segment was built at all");
  // Wait for the research round and its retry to give up.
  for (let i = 0; i < 200 && !segment.complete; i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(segment.complete, "the segment never finished");

  const spoken = segment.turns.map((t) => t.text).join(" ");
  assert.match(spoken, /nothing came back/i, `expected the honest lines, got: ${spoken}`);
  assert.equal(
    /technical problem at the desk/i.test(spoken),
    false,
    "the model was called anyway and the failure surfaced as a technical fault",
  );
  assert.equal(segment.unresearched, true, "the segment was not marked unresearched");
  assert.deepEqual(segment.coverKeys, [], "an unresearched subject was marked covered");
  assert.equal(segment.error, null, "a generation error means the gate was not what stopped it");
});

test("the honest lines are fixed text, pre-rendered like the bridges", async () => {
  const source = await fs.readFile(new URL("../src/show.js", import.meta.url), "utf8");
  const block = source.slice(source.indexOf("const NO_RESEARCH = {"), source.indexOf("const newId ="));
  assert.ok(/didn't come back|nothing came back/i.test(block), "the fallback does not say what happened");
  assert.equal(/\$\{/.test(block), false, "the fallback interpolates, so it is not fixed text");
  assert.ok(
    /Object\.values\(NO_RESEARCH\)/.test(source),
    "the fallback lines are not rendered at boot, so they arrive late",
  );
});

test("a subject with no sources is not marked as covered", async () => {
  // Otherwise a search outage silently burns the subject for good.
  const source = await fs.readFile(new URL("../src/show.js", import.meta.url), "utf8");
  const build = source.slice(source.indexOf("async buildNextSegment("));
  const gate = build.slice(build.indexOf("if (!research.usable)"));
  const body = gate.slice(0, gate.indexOf("return null;"));
  assert.ok(/coverKeys = \[\]/.test(body), "an unresearched subject was marked covered");
});

/* ---------- taking the call ---------- */

test("the hosts react to a call while the search is still running", async () => {
  const source = await fs.readFile(new URL("../src/show.js", import.meta.url), "utf8");
  const submit = source.slice(source.indexOf("async submitCall("));
  const body = submit.slice(0, submit.indexOf("\n  /**"));
  // Two segments: what the hosts say about the question, then the answer to it.
  assert.ok(/const cover = new Segment/.test(body), "there is nothing on air while the search runs");
  assert.ok(/scriptCallerCover\(/.test(body), "the cover is not written");
  // The cover must not wait on the research.
  const coverAt = body.indexOf("scriptCallerCover(");
  const researchAt = body.indexOf("researchWithRetry(");
  assert.ok(coverAt < researchAt, "the hosts' reaction waits on the search it is covering");
  assert.ok(/knownFor/.test(body), "the hosts cannot recognise a caller they have heard before");
});

test("the cover states no fact, and is where the caller's interests are read", async () => {
  const source = await fs.readFile(new URL("../src/llm.js", import.meta.url), "utf8");
  const fn = source.slice(source.indexOf("export async function scriptCallerCover"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.ok(/state no fact/i.test(body), "the cover is allowed to answer the question");
  assert.ok(/COVER_SCHEMA/.test(body), "the cover cannot record what the caller cares about");
  // The answer prompt has no "say you don't know" branch, because it is never
  // called without sources.
  const answer = source.slice(source.indexOf("export async function scriptCallerSegment"));
  const answerBody = answer.slice(0, answer.indexOf("\n}\n"));
  assert.equal(
    /answer from what you do have/i.test(answerBody),
    false,
    "the answer prompt still invites the model to fill in the gap",
  );
});

test("what the caller asked about is learned even when the search fails them", async () => {
  const source = await fs.readFile(new URL("../src/show.js", import.meta.url), "utf8");
  const submit = source.slice(source.indexOf("async submitCall("));
  const body = submit.slice(0, submit.indexOf("\n  /**"));
  const gate = body.slice(body.indexOf("if (!research.usable)"));
  assert.ok(
    /learnFromCall\(/.test(gate.slice(0, gate.indexOf("return;"))),
    "a failed search also lost what the listener told us they cared about",
  );
});

/* ---------- the head start ---------- */

test("naming the subject starts the research, keyed so a change of mind is not read", async () => {
  const { primeResearch, claimPrimedResearch } = await import("../src/research.js");
  primeResearch({ researchId: "rid_first", query: "whales", subject: "whales", show: {} });
  // A different description is a different id; the first is never read for it.
  assert.equal(await claimPrimedResearch({ researchId: "rid_second", subject: "whales", show: {} }), null);
  // And an unusable head start is not passed off as research.
  assert.equal(
    await claimPrimedResearch({ researchId: "rid_first", subject: "whales", show: {} }),
    null,
    "an empty head start was handed on",
  );
  // Consumed on read, so it cannot be recycled later in the episode.
  primeResearch({ researchId: "rid_third", query: "whales", subject: "whales", show: {} });
  await claimPrimedResearch({ researchId: "rid_third", subject: "whales", show: {} });
  assert.equal(
    await claimPrimedResearch({ researchId: "rid_third", subject: "whales", show: {} }),
    null,
    "the head start was read twice",
  );
});

test("only the first subject of an episode can use the head start", async () => {
  const source = await fs.readFile(new URL("../src/show.js", import.meta.url), "utf8");
  const build = source.slice(source.indexOf("async buildNextSegment("));
  const body = build.slice(0, build.indexOf("\n  async #run("));
  // State, not a count of what has aired: the opening marks itself covered the
  // moment it plays, so counting made this false before the first subject existed.
  assert.ok(/this\.headStart && this\.headStart\.generation === this\.planGeneration/.test(body),
    "there is no first-subject test, or it ignores the episode it belongs to");
  assert.ok(/this\.headStart = null;/.test(body), "the head start is never spent");
  assert.ok(/headStart: headStart/.test(body), "every subject reads the head start");
  // ...and it has to be in the options argument, where researchWithRetry reads it.
  const retry = source.slice(source.indexOf("async function researchWithRetry"));
  assert.ok(
    /researchWithRetry\(args, \{ onRetry, headStart = null \} = \{\}\)/.test(retry),
    "the head start is passed somewhere it is never read",
  );
});

test("the head start is matched against what the segment is really about", async () => {
  const { stronglyAbout } = await import("../src/research.js");
  const primed = "ancient history, starting with Roman aqueducts";
  // A plan title is a screen label. Matched against it alone, a head start that
  // genuinely covered the subject was thrown away; the query names the subject in
  // full, because a search engine receives it with no other context.
  assert.equal(stronglyAbout(primed, "Quarry and stone"), false, "the title alone is enough to match");
  assert.ok(
    stronglyAbout(primed, "Quarry and stone Roman aqueducts: the quarries the stone came from"),
    "a head start about this very subject was discarded",
  );
  // And the query does not open a door to a neighbouring subject.
  assert.equal(
    stronglyAbout(primed, "The Roman road network Roman roads: how the viae were surveyed"),
    false,
    "material about aqueducts was claimed as evidence about roads",
  );
});

test("one shared word is not the same subject", async () => {
  const { stronglyAbout } = await import("../src/research.js");
  // The case this exists for: material about Roman roads presented as evidence
  // about Roman aqueducts is worse than no research, because it arrives cited.
  assert.equal(stronglyAbout("Roman roads", "Roman aqueducts"), false);
  assert.ok(stronglyAbout("Roman aqueducts", "how Roman aqueducts moved water"));
  assert.ok(stronglyAbout("the deep sea and its animals", "deep sea gigantism"));
  assert.equal(stronglyAbout("ancient Roman aqueducts", "the Chicago Bears"), false);
  // A subject named in one word has to appear whole in the other.
  assert.ok(stronglyAbout("whales", "sperm whale dive physiology"));
  assert.equal(stronglyAbout("whales", "deep sea pressure"), false);
  assert.equal(stronglyAbout("", "anything"), false);
});

test("the head start is matched against what was searched, not a tidied-up summary", async () => {
  const { stronglyAbout } = await import("../src/research.js");
  const wanted = "Quarry and stone. Roman aqueducts: where the stone came from.";

  // The derived subject can lose the starter the listener actually named, and on
  // its own it is one shared token — so a head start that covered exactly this
  // subject was being thrown away.
  assert.equal(stronglyAbout("ancient history", wanted), false);
  // The verbatim request is what the material came back from, and it matches.
  assert.ok(
    stronglyAbout("ancient history. start with Roman aqueducts.", wanted),
    "the request that was actually searched still fails to match its own subject",
  );
  // And it is no looser: a neighbouring subject is still refused.
  assert.equal(
    stronglyAbout(
      "ancient history. start with Roman aqueducts.",
      "The Roman road network. Roman roads: how the viae were surveyed.",
    ),
    false,
    "matching the verbatim request loosened into a neighbouring subject",
  );

  const source = await fs.readFile(new URL("../src/research.js", import.meta.url), "utf8");
  assert.ok(
    /const searched = entry\.query \|\| entry\.subject/.test(source),
    "the claim still compares the derived subject rather than the request",
  );
});

test("a head start belongs to one description, one episode, and one set of rules", async () => {
  const { primeResearch, claimPrimedResearch } = await import("../src/research.js");
  const evergreen = { families: ["reference"], freshness: null };

  primeResearch({ researchId: "rid_a", query: "q", subject: "Roman aqueducts", show: evergreen });
  // Somebody else's id gets nothing, whatever they are asking about.
  assert.equal(
    await claimPrimedResearch({ researchId: "rid_other", subject: "Roman aqueducts", show: evergreen }),
    null,
  );
  // Adjacent is not the same subject.
  assert.equal(
    await claimPrimedResearch({ researchId: "rid_a", subject: "Roman roads", show: evergreen }),
    null,
    "material about one subject was handed over as evidence for its neighbour",
  );

  // Material gathered for an evergreen show is not interchangeable with material
  // for a current-affairs one: different sources, different recency, different job.
  primeResearch({ researchId: "rid_b", query: "q", subject: "Roman aqueducts", show: evergreen });
  assert.equal(
    await claimPrimedResearch({
      researchId: "rid_b",
      subject: "Roman aqueducts",
      show: { families: ["news"], freshness: "the last 48 hours" },
    }),
    null,
    "research gathered under one set of rules was reused under another",
  );
});

/* ---------- episode roadmaps and infrequent call-in reminders ---------- */

test("a valid short outline stays short and supplies an ordered research plan", async () => {
  const { normalizeEpisodeOutline, episodeOutlinePlan, firstEpisodeResearchSubject } = await import("../src/showdef.js");
  const beats = ["Reading the stars", "Updating the state vector", "Correcting the course"];
  assert.deepEqual(normalizeEpisodeOutline(beats), beats);
  const show = defineShow({
    about: "the Apollo moon landing", episodeFocus: "Apollo navigation mathematics",
    title: "Fixing Position", episodeOutline: beats,
  });
  assert.deepEqual(show.episodeOutline, beats);
  assert.deepEqual(defineShow(show).episodeOutline, beats);
  const plan = episodeOutlinePlan(show);
  assert.deepEqual(plan.map(item => item.title), beats);
  for (const [i, item] of plan.entries()) {
    assert.ok(item.query.includes(show.about));
    assert.ok(item.query.includes(show.episodeFocus));
    assert.ok(item.query.includes(beats[i]));
  }
  assert.equal(firstEpisodeResearchSubject(show), plan[0].query);
});

test("outline validation drops junk and duplicates and bounds old-show defaults", async () => {
  const { normalizeEpisodeOutline } = await import("../src/showdef.js");
  const outline = normalizeEpisodeOutline([null, {}, 8, "", "  First beat  ", "first beat", "x".repeat(300)]);
  assert.ok(outline.length >= 3 && outline.length <= 5);
  assert.equal(outline.filter(x => x.toLowerCase() === "first beat").length, 1);
  assert.ok(outline.every(x => typeof x === "string" && x.length <= 140 && x !== "[object Object]" && x !== "8"));
  const legacy = defineShow({ about: "the history of printing" });
  assert.ok(legacy.episodeOutline.length >= 3 && legacy.episodeOutline.length <= 5);
});

test("a new episode replaces the old outline without renaming the series", async () => {
  const { nextEpisodeDefinition } = await import("../src/showdef.js");
  const original = defineShow({ about: "printing", title: "Impression", episodeFocus: "movable type", episodeOutline: ["A", "B", "C"] });
  const next = nextEpisodeDefinition(original, { episodeTitle: "Sticky Ink", episodeFocus: "printing ink", episodeOutline: ["D", "E", "F"] });
  assert.equal(next.seriesId, original.seriesId);
  assert.equal(next.title, original.title);
  assert.deepEqual(next.episodeOutline, ["D", "E", "F"]);
  assert.notEqual(next.episodeId, original.episodeId);
});

test("reminders use completed listening time and wait for a natural boundary", async () => {
  const { countedHeardSeconds, callInReminderDue } = await import("../src/show.js");
  assert.equal(countedHeardSeconds({ phase: "started", heardSeconds: 90 }), 0);
  assert.equal(countedHeardSeconds({ phase: "skipped", heardSeconds: 90 }), 0);
  assert.equal(countedHeardSeconds({ phase: "finished", heardSeconds: 90, alreadyCounted: true }), 0);
  assert.equal(countedHeardSeconds({ phase: "finished", heardSeconds: 13.4 }), 13.4);
  for (const value of [-1, NaN, Infinity]) assert.equal(countedHeardSeconds({ phase: "finished", heardSeconds: value }), 0);
  assert.ok(countedHeardSeconds({ phase: "finished", heardSeconds: 1e9 }) <= 600);
  assert.equal(callInReminderDue({ heardSeconds: 299, atBoundary: true }), false);
  assert.equal(callInReminderDue({ heardSeconds: 300, atBoundary: false }), false);
  assert.equal(callInReminderDue({ heardSeconds: 300, atBoundary: true }), true);
  assert.equal(callInReminderDue({ heardSeconds: 779, lastReminderAtSeconds: 300, atBoundary: true }), false);
  assert.equal(callInReminderDue({ heardSeconds: 780, lastReminderAtSeconds: 300, atBoundary: true }), true);
  assert.equal(callInReminderDue({ heardSeconds: 10000, hasCalled: true, atBoundary: true }), false);
});

test("progress dedupes reminder time and inserts the reminder before the next topic", async () => {
  const show = await runningShow("reminder-sequence");
  const topic = fakeSegment({ turns: [{ text: "one" }, { text: "two" }, { text: "three" }] });
  const next = fakeSegment({ title: "Next beat" });
  show.segments.push(topic, next);
  show.deliveredThrough = 0;
  show.reportProgress({ segmentId: topic.id, turnIndex: 9, phase: "finished", heardSeconds: 600 });
  assert.equal(show.heardSeconds, 0);
  show.reportProgress({ segmentId: topic.id, turnIndex: 0, phase: "started", heardSeconds: 600 });
  assert.equal(show.heardSeconds, 0);
  show.reportProgress({ segmentId: topic.id, turnIndex: 0, phase: "finished", heardSeconds: 150 });
  show.reportProgress({ segmentId: topic.id, turnIndex: 0, phase: "finished", heardSeconds: 150 });
  assert.equal(show.heardSeconds, 150);
  show.reportProgress({ segmentId: topic.id, turnIndex: 1, phase: "finished", heardSeconds: 150 });
  assert.equal(show.segments.length, 2, "reminder interrupted the middle of a segment");
  show.reportProgress({ segmentId: topic.id, turnIndex: 2, phase: "finished", heardSeconds: 10 });
  assert.equal(show.segments[1].bridgeRole, "call-reminder");
  assert.equal(show.segments[2], next);
  show.reportProgress({ segmentId: topic.id, turnIndex: 2, phase: "finished", heardSeconds: 10 });
  assert.equal(show.segments.filter(x => x.bridgeRole === "call-reminder").length, 1);
  show.queueCall();
  assert.equal(show.hasCalled, true);
  assert.ok(!show.segments.some(segment => segment.bridgeRole === "call-reminder"), "queued reminder survived a real call");
  show.reset();
  assert.equal(show.heardSeconds, 0);
  assert.equal(show.hasCalled, false);
  assert.equal(show.lastCallReminderAtSeconds, null);
});

/* ---------- the top of the episode ---------- */

test("the opening distinguishes a new request from a returning episode", async () => {
  const { openingIntroduction } = await import("../src/llm.js");
  const series = defineShow({
    about: "the Apollo moon landing",
    title: "Needles in a Moving Sky",
    episodeTitle: "Where Are We?",
    episodeFocus: "how the crew knew where they were",
    episodeNumber: 1,
  });
  const first = openingIntroduction(series);
  assert.equal(first.firstEpisode, true);
  assert.match(first.introduction, /one spoken request/);
  assert.match(first.introduction, /never heard these hosts before/);
  assert.match(first.introduction, /That sounds great/);
  assert.match(first.introduction, /Needles in a Moving Sky/);
  assert.match(first.introduction, /Where Are We\?/);

  const returning = openingIntroduction(defineShow({
    ...series,
    episodeNumber: 2,
    episodeTitle: "The Descent Engine's One Shot",
    episodeFocus: "the lunar module descent engine",
  }));
  assert.equal(returning.firstEpisode, false);
  assert.match(returning.introduction, /episode 2 of an existing series/);
  assert.match(returning.introduction, /welcomes the listener back/);
  assert.match(returning.introduction, /already knows the hosts/);
  assert.match(returning.introduction, /The Descent Engine's One Shot/);
  assert.match(returning.introduction, /Do not say "that sounds great"/i);
  assert.match(returning.introduction, /Do not give first-time host introductions/);
});

test("the head start is retired when the podcast it belonged to is replaced", async () => {
  const { showFor } = await import("../src/show.js");
  const { defineShow } = await import("../src/showdef.js");
  const { primeResearch } = await import("../src/research.js");
  const show = showFor("head-start-owner");

  primeResearch({ researchId: "rid_owned", query: "q", subject: "whales", show: {} });
  await show.define(defineShow({ about: "whales" }), { researchId: "rid_owned" });
  assert.equal(show.headStart.researchId, "rid_owned");
  assert.equal(show.headStart.generation, show.planGeneration);

  // A new podcast drops it rather than letting the next episode read it.
  await show.define(defineShow({ about: "the NBA" }));
  assert.equal(show.headStart, null, "research for the old podcast survived into the new one");
});

test("the call button waits for the answer, not for the hosts' reaction to it", async () => {
  // The cover starts within seconds while the search is still running. Freeing the
  // button there just puts the listener into a second call the server refuses.
  const app = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const fn = app.slice(app.indexOf("async function doneSpeaking"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.ok(/awaitingAnswerId = result\.answerSegmentId/.test(body), "the call button frees too early");
  // ...while the transcript entry is still keyed to the segment carrying the words.
  assert.ok(/appendCallerQuestion\(result\.coverSegmentId/.test(body), "the question is keyed to the wrong segment");
});

test("an event with a link but nothing in it is not evidence", async () => {
  const { isUsable } = await import("../src/research.js");
  const url = "https://apnews.com/a";
  assert.equal(isUsable({ events: [{ sources: [url] }], show: {} }), false, "an empty event passed as evidence");
  assert.equal(isUsable({ events: [{ headline: "   ", sources: [url] }], show: {} }), false);
  assert.ok(isUsable({ events: [{ headline: "Something happened", sources: [url] }], show: {} }));
  assert.ok(isUsable({ events: [{ abstract: "Officials said…", sources: [url] }], show: {} }));
});

/* ---------- the audio unlock clip ---------- */

test("the silent unlock clip is a playable WAV with real frames", async () => {
  // A header-only WAV decodes to nothing and does not reliably unlock an audio
  // element. This also catches the clip being broken by line-wrapping the base64
  // anywhere other than a 4-character boundary, which silently shifts the decode.
  const source = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const match = source.match(/const SILENCE =\s*\n\s*"data:audio\/wav;base64,([A-Za-z0-9+/=]+)";/);
  assert.ok(match, "SILENCE is not a single unbroken base64 literal");

  const wav = Buffer.from(match[1], "base64");
  assert.equal(wav.subarray(0, 4).toString(), "RIFF");
  assert.equal(wav.subarray(8, 12).toString(), "WAVE");

  const sampleRate = wav.readUInt32LE(24);
  const bitsPerSample = wav.readUInt16LE(34);
  const dataBytes = wav.readUInt32LE(40);
  const frames = dataBytes / (bitsPerSample / 8);
  assert.ok(frames > 0, "the unlock clip contains no audio frames");
  assert.equal(dataBytes + 44, wav.length, "the declared data size does not match the file");
  assert.ok(frames / sampleRate >= 0.005, "the unlock clip is too short to reliably start");
});

test("the caller's question is its own transcript entry, printed before the hold line", async () => {
  // Playback order is: question spoken, "let me pull that up", answer. Hanging the
  // question off the answer segment built the answer's block first, so every host
  // line then landed above the hold line and the transcript read backwards.
  const source = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.ok(
    /function appendCallerQuestion\(/.test(source),
    "the caller's question is not a section of its own",
  );
  const fn = source.slice(source.indexOf("function appendCallerQuestion"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.equal(
    /sectionFor\(/.test(body),
    false,
    "printing the question builds the answer's section ahead of the hold line",
  );
  // And on reload it is printed once, not twice.
  assert.ok(
    /!state\.sections\.has\(callerSectionId\(segment\.id\)\)/.test(source),
    "a reloaded caller segment prints the question a second time",
  );
});

test("an in-flight turn can be settled from outside, and only by its owner", async () => {
  // Pausing the element and dropping its source fire neither `ended` nor `error`,
  // so tearing an episode down mid-line has to settle that promise explicitly or
  // the loop awaiting it never returns.
  const source = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const play = source.slice(source.indexOf("async function playTurn"));
  const playBody = play.slice(0, play.indexOf("\n}\n"));
  assert.ok(/cancel = \(\) => finish\("cancelled"\)/.test(playBody), "a turn cannot be cancelled");
  assert.ok(/state\.cancelTurn === cancel/.test(playBody), "the cancel slot is cleared by the wrong turn");

  const end = source.slice(source.indexOf("async function endEpisode"));
  const endBody = end.slice(0, end.indexOf("\n}\n"));
  const cancelAt = endBody.indexOf("state.cancelTurn?.()");
  const stopAudioAt = endBody.indexOf("state.audio.pause()");
  const abortAt = endBody.indexOf("state.abort.abort()");
  assert.ok(cancelAt >= 0, "teardown never settles the turn on air");
  assert.ok(
    cancelAt < stopAudioAt && cancelAt < abortAt,
    "teardown stops audio or aborts the episode before settling the turn",
  );
});

test("a resume-gate tap from a finished episode does not restart audio", async () => {
  const source = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const fn = source.slice(source.indexOf("function showResumeGate"));
  const body = fn.slice(0, fn.indexOf("\n};\n"));
  assert.ok(/epoch !== state\.epoch/.test(body), "the gate replays audio from a torn-down episode");
});

test("the recorder starts before the progress report, not after it", async () => {
  // The progress report is a network round trip. Between the audible "caller,
  // you're on" and a recorder that starts after it, a phone loses the first words.
  const source = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const fn = source.slice(source.indexOf("async function playSegment"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  const playedAt = body.indexOf("await playTurn(");
  const micAt = body.indexOf("await openMicrophone()", playedAt);
  const progressAt = body.indexOf('await postProgress(', playedAt);
  assert.ok(micAt > playedAt, "the microphone opens before the invitation finishes");
  assert.ok(micAt < progressAt, "the recorder waits on a network round trip after the spoken cue");
});

test("a recorder that never actually starts is treated as a failure", async () => {
  const source = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const fn = source.slice(source.indexOf("async function openMicrophone"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.ok(
    /state\.recorder\?\.state !== "recording"/.test(body),
    "a lapsed start timeout is treated as a working microphone",
  );
  assert.ok(/await stopRecording\(\)/.test(body), "a failed start leaves the microphone open");
  assert.ok(/echoCancellation/.test(source), "the hosts are recorded back into the caller's audio");
});

test("the on-air cue waits for the recorder to report that it started", async () => {
  const source = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const fn = source.slice(source.indexOf("async function openMicrophone"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  const startedAt = body.indexOf("onstart");
  const cueAt = body.indexOf('phase = "live"');
  assert.ok(startedAt > 0, "the recorder's start event is not awaited");
  assert.ok(cueAt > startedAt, "the on-air cue goes up before the recorder is running");
});

test("ending an episode always clears the pause", async () => {
  // Otherwise `paused` carries into the next episode, whose first line then waits
  // on a Pause button the listener has no reason to touch.
  const source = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const fn = source.slice(source.indexOf("async function endEpisode"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.ok(/setPaused\(false\)/.test(body), "a paused episode stays paused into the next one");
  assert.ok(/dismissResumeGate/.test(body), "the resume dialog is left up over the setup form");
  assert.ok(/state\.abort\.abort\(\)/.test(body), "the old episode's long poll is left running");
});

test("playback carries the epoch it belongs to", async () => {
  const source = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
  for (const fn of ["playSegment", "playTurn", "waitWhilePaused"]) {
    const decl = new RegExp(`function ${fn}\\([^)]*epoch`);
    assert.ok(decl.test(source), `${fn} does not know which episode it is playing`);
  }
  assert.ok(/function stale\(segment, epoch\)/.test(source), "staleness ignores the episode");
});

test("the microphone analyser is never wired to the speakers", async () => {
  // Connecting a live microphone to the destination is feedback in a room where
  // the hosts are also playing. The graph must analyse it and stop there.
  const source = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const fn = source.slice(source.indexOf("function attachMicAnalyser"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.ok(body.includes("createMediaStreamSource"), "the mic is not analysed at all");
  assert.equal(/connect\(\s*room\.ctx\.destination/.test(body), false, "the mic reaches the speakers");
});

test("the show's audio element is routed back to the speakers", async () => {
  // Routing an element through Web Audio and forgetting the destination is a
  // silent show, and it fails in exactly the place nobody looks.
  const source = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const fn = source.slice(source.indexOf("function attachRoomAnalyser"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.ok(body.includes("createMediaElementSource"), "the element is not analysed");
  assert.ok(/connect\(room\.ctx\.destination\)/.test(body), "the element was routed nowhere");
  assert.ok(/state !== "running"/.test(body), "the graph is built without checking the context");
});

/* ---------- run ---------- */

for (const [name, fn] of tests) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}\n      ${err.message}`);
    process.exitCode = 1;
  }
}
console.log(`\n${passed}/${tests.length} passed`);
if (process.exitCode && warnings.length) {
  console.error(`\nsuppressed warnings:\n${[...new Set(warnings)].slice(0, 10).join("\n")}`);
}
// Fire-and-forget profile writes can still be in flight; let them land before
// pulling the directory out from under them.
await new Promise((r) => setTimeout(r, 150));
await fs.rm(process.env.NEWSCAST_DATA_DIR, {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 100,
});
