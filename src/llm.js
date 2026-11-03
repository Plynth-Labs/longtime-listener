import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { outletName } from "./outlets.js";

const client = new Anthropic({
  apiKey: config.anthropic.apiKey,
  ...(config.anthropic.baseUrl ? { baseURL: config.anthropic.baseUrl } : {}),
});

const TURNS = {
  type: "array",
  items: {
    type: "object",
    properties: {
      speaker: { type: "string", enum: ["ari", "dev", "producer"] },
      text: { type: "string" },
    },
    required: ["speaker", "text"],
    additionalProperties: false,
  },
};

const PLAN = {
  type: "array",
  items: {
    type: "object",
    properties: {
      title: { type: "string" },
      query: { type: "string" },
      why: { type: "string" },
    },
    required: ["title", "query", "why"],
    additionalProperties: false,
  },
};

/**
 * What the *caller* is interested in — not what the hosts happened to name. The
 * distinction is the whole point: learning every proper noun that appeared in a
 * generated answer is how a listener ends up with a stranger pinned to their
 * profile for the crime of being mentioned once.
 */
const INTERESTS = {
  type: "object",
  properties: {
    topics: { type: "array", items: { type: "string" } },
    entities: { type: "array", items: { type: "string" } },
  },
  required: ["topics", "entities"],
  additionalProperties: false,
};

const PREFERENCES = {
  type: "array",
  items: {
    type: "object",
    properties: {
      label: { type: "string" },
      direction: { type: "string", enum: ["more", "less"] },
    },
    required: ["label", "direction"],
    additionalProperties: false,
  },
};

const EPISODE_OUTLINE = {
  type: "array",
  items: { type: "string" },
};

const object = (properties) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

const PREMISE_SCHEMA = object({
  about: { type: "string" },
  episodes: { type: "string" },
  angle: { type: "string" },
  title: { type: "string" },
  brief: { type: "string" },
  episodeTitle: { type: "string" },
  episodeBrief: { type: "string" },
  episodeFocus: { type: "string" },
  episodeOutline: EPISODE_OUTLINE,
});
const NEXT_EPISODE_SCHEMA = object({
  episodeTitle: { type: "string" },
  episodeBrief: { type: "string" },
  episodeFocus: { type: "string" },
  episodeOutline: EPISODE_OUTLINE,
});

const OPENING_SCHEMA = object({ turns: TURNS });
const SEGMENT_SCHEMA = object({ turns: TURNS });
// The cover: what the hosts say while the search is still running. It is also
// where what the caller cares about is read off, because that is a fact about the
// question and does not depend on whether the search came back.
const COVER_SCHEMA = object({
  turns: TURNS,
  interests: INTERESTS,
  preferences: PREFERENCES,
});
const CALLER_SCHEMA = object({ turns: TURNS, plan: PLAN });
const REPLAN_SCHEMA = object({ plan: PLAN });

/**
 * Pulls complete `{speaker, text}` objects out of a partially-streamed JSON body
 * so the first line can be sent to text-to-speech before the model has finished
 * writing the last one. This is where most of the perceived latency goes.
 *
 * It anchors on the `turns` key rather than on the first `[` in the buffer: these
 * responses also carry a plan and two interest arrays, and whichever array the
 * model emits first is not necessarily the dialogue.
 */
export class TurnExtractor {
  constructor() {
    this.buf = "";
    this.pos = 0;
    this.started = false;
    this.producerTurns = 0;
  }

  push(chunk) {
    this.buf += chunk;
    return this.#drain();
  }

  #drain() {
    const out = [];
    if (!this.started) {
      const key = /"turns"\s*:\s*\[/.exec(this.buf);
      if (!key) return out;
      this.started = true;
      this.pos = key.index + key[0].length;
    }
    for (;;) {
      let i = this.pos;
      while (i < this.buf.length && (this.buf[i] === " " || this.buf[i] === "\n" || this.buf[i] === "\r" || this.buf[i] === "\t" || this.buf[i] === ",")) i++;
      // A `]` here is the end of the dialogue array; anything else that is not an
      // object start is an incomplete chunk we should wait on.
      if (i >= this.buf.length || this.buf[i] !== "{") {
        this.pos = i;
        return out;
      }
      let depth = 0;
      let inString = false;
      let escaped = false;
      let end = -1;
      for (let j = i; j < this.buf.length; j++) {
        const c = this.buf[j];
        if (inString) {
          if (escaped) escaped = false;
          else if (c === "\\") escaped = true;
          else if (c === '"') inString = false;
          continue;
        }
        if (c === '"') inString = true;
        else if (c === "{") depth++;
        else if (c === "}") {
          depth--;
          if (depth === 0) {
            end = j;
            break;
          }
        }
      }
      if (end === -1) {
        this.pos = i;
        return out;
      }
      const slice = this.buf.slice(i, end + 1);
      try {
        const obj = JSON.parse(slice);
        if (obj && typeof obj.text === "string" && ["ari", "dev", "producer"].includes(obj.speaker)) {
          // Sam is an occasional producer, not a third co-host. Enforce the cap at
          // the streaming boundary, before a second producer turn can reach TTS.
          if (obj.speaker !== "producer" || this.producerTurns++ === 0) out.push(obj);
        }
      } catch {
        /* the model emitted something the schema will reject; skip it */
      }
      this.pos = end + 1;
    }
  }

  final() {
    try {
      const parsed = JSON.parse(this.buf);
      let producerTurns = 0;
      parsed.turns = (parsed.turns ?? []).filter((turn) => {
        if (!turn || typeof turn.text !== "string" || !["ari", "dev", "producer"].includes(turn.speaker)) {
          return false;
        }
        if (turn.speaker !== "producer") return true;
        producerTurns += 1;
        return producerTurns === 1;
      });
      return parsed;
    } catch {
      return { turns: [] };
    }
  }
}

/** House rules, generated per show so the hosts know what podcast they are on. */
function houseStyle(show) {
  return `
You write the spoken script for a hosted podcast. Output is read aloud by
text-to-speech, so write only words a person would say.

THIS PODCAST
- Series title: ${show.title}
- Series brief: ${show.brief}
- What it is about: ${show.about}
- What an episode covers: ${show.episodes}
- What makes it different: ${show.angle}
- This episode: ${show.episodeTitle}
- Episode brief: ${show.episodeBrief}
- The facet this episode stays inside: ${show.episodeFocus}
- Promised episode roadmap, in order:
${(show.episodeOutline ?? []).map((beat) => `  - ${beat}`).join("\n") || "  - Follow the episode focus closely"}

Everything the hosts say has to belong on *this* podcast. A subject that does not
serve the premise above does not go in the episode, however interesting it is.

THE HOSTS
- ari — ${config.hosts.ari.persona}
- dev — ${config.hosts.dev.persona}
- producer — ${config.hosts.producer.persona}

HOW THEY TALK
- Every turn is one or two sentences. Never three. Vary the length.
- Be direct. Lead with the thing itself. No throat-clearing, no "great question",
  no restating what your co-host just said before adding to it, no summarising at
  the end of a turn what the turn already said.
- Both hosts bring findings. They can ask each other honest questions or briefly
  disagree from their packets, but never use automatic praise such as "exactly",
  "good point", or "that's right" as conversational glue.
- Alternate speakers unless a single follow-up genuinely belongs to the same host.
- Sam, identified by speaker "producer", may interject at most once in a segment.
  Sam listens like an interested layperson and asks one short, basic clarification,
  such as "Why did that matter?" or "What does that mean?" Sam uses no technical
  terms, introduces no fact or number, and has no research assignment. Ari or Dev
  answers from their sourced notes. Sam is the producer, not a third co-host.
- No markdown, no headings, no bullets, no stage directions, no emoji, no URLs.
- Say numbers and dates the way a person says them out loud.
- Attribute by name — "the Journal reported", "according to NASA". Never say how
  many newsrooms or outlets carried something; a count of coverage is not a fact
  about the world and it tells the listener nothing.
- If the reporting is thin, disputed, or still developing, say so instead of
  smoothing it over.
- Do not invent detail that is not in the material you were given. If the hosts do
  not know something, they say they do not know it.
- Some subjects involve real harm. Do not be glib about it.
- Do not include internal or system XML tags in your response.
`.trim();
}

/** How long and how deep this listener wants segments, from the pacing control. */
function pacingBrief(pacing = 0) {
  if (pacing <= -2) {
    return "This listener keeps asking you to hurry up. Write 3 to 4 turns. Headline, one line of why it matters, move on.";
  }
  if (pacing === -1) {
    return "This listener leans impatient. Write 4 to 5 turns and keep every one tight.";
  }
  if (pacing === 1) {
    return "This listener keeps asking you to go deeper. Write 7 to 9 turns and get past the summary into mechanism, history, and disagreement.";
  }
  if (pacing >= 2) {
    return "This listener wants real depth. Write 9 to 12 turns. Go past the surface entirely: mechanism, numbers, who disagrees and why, what would change your mind.";
  }
  return "Write 5 to 7 turns.";
}

/** The research note the hosts are working from, as prompt material. */
function researchBlock(research) {
  if (!research) return "";
  if (Array.isArray(research.packets)) {
    const packets = research.packets.map((packet) => {
      const label = packet.speaker === "ari" ? "ARI" : "DEV";
      if (!packet.usable || !packet.research) {
        return `${label}'S INDEPENDENT RESEARCH PACKET: unavailable (${packet.status}). ${label} must not claim to have found or verified any fact in this round.`;
      }
      return `${label}'S INDEPENDENT RESEARCH PACKET — ${packet.angle}:\n${researchBlock(packet.research)}`;
    });
    packets.push(
      "PRODUCER ROLE: Sam has no research packet. Sam may react with one short, basic layperson's clarification, using no technical terms, facts, or numbers. Ari or Dev answers from the sourced packets above.",
    );
    return packets.join("\n\n");
  }
  const parts = [];
  if (research.web?.summary) {
    const outlets = [...new Set((research.web.sources ?? []).map((s) => s.name).filter(Boolean))];
    parts.push(
      `CURRENT REPORTING (searched just now${outlets.length ? `, from ${outlets.join(", ")}` : ""}):\n${research.web.summary}`,
    );
  }
  for (const page of research.wiki ?? []) {
    parts.push(`BACKGROUND — Wikipedia, "${page.title}":\n${page.extract}`);
  }
  if (research.stories?.length) {
    parts.push(`ALSO ON THE WIRE:\n${storyBlock(research.stories)}`);
  }
  return parts.join("\n\n");
}

/**
 * Wire stories as prompt material. Deliberately carries no corroboration count:
 * the count is used to *rank* stories on the way in and is never something the
 * hosts should say out loud.
 */
export function storyBlock(stories) {
  return stories
    .map((s, i) => {
      const who = (s.entities ?? []).map((e) => e.name).slice(0, 4).join(", ");
      const outlets = [...new Set((s.sources ?? []).map((u) => outletName(u)).filter(Boolean))];
      return [
        `[${i + 1}] ${s.headline}`,
        s.abstract,
        who ? `key actors: ${who}` : null,
        outlets.length ? `reported by: ${outlets.join(", ")}` : null,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

/**
 * Worth one retry: an overloaded or rate-limited model, caught before a single
 * line has gone out. Once a turn has been emitted it is already rendering to
 * speech and may already be on air, so retrying there would repeat it — which is
 * why this only ever fires from a standing start.
 */
function worthRetrying(err) {
  const status = err?.status ?? err?.error?.status;
  const type = err?.error?.error?.type ?? err?.error?.type;
  return status === 429 || status === 529 || (typeof status === "number" && status >= 500) ||
    type === "overloaded_error" || type === "api_error";
}

async function streamScript({ system, prompt, schema, maxTokens = 2600, onTurn }) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await streamOnce({ system, prompt, schema, maxTokens, onTurn });
    } catch (err) {
      // `emitted` is zero here by construction: streamOnce only throws before its
      // first turn, or after re-raising something a retry cannot help with.
      if (attempt >= 1 || !worthRetrying(err) || err.emitted) throw err;
      console.warn(`[llm] ${err.message?.slice(0, 120)} — retrying once`);
      await new Promise((r) => setTimeout(r, 700));
    }
  }
}

async function streamOnce({ system, prompt, schema, maxTokens, onTurn }) {
  const extractor = new TurnExtractor();
  let emitted = 0;

  const stream = client.messages.stream({
    model: config.anthropic.model,
    max_tokens: maxTokens,
    // Thinking off + low effort: the script has to land before the segment on air
    // ends. Structured outputs keep the shape valid without a reasoning pass.
    thinking: { type: "disabled" },
    output_config: { effort: config.anthropic.effort, format: { type: "json_schema", schema } },
    system,
    messages: [{ role: "user", content: prompt }],
  });

  stream.on("text", (delta) => {
    for (const turn of extractor.push(delta)) {
      emitted += 1;
      onTurn?.(turn, emitted - 1);
    }
  });

  let message;
  try {
    message = await stream.finalMessage();
  } catch (err) {
    // Tell the retry wrapper whether anything already went to air.
    if (emitted) err.emitted = emitted;
    throw err;
  }
  if (message.stop_reason === "refusal") {
    const err = new Error("The model declined to script this segment.");
    err.code = "REFUSAL";
    err.details = message.stop_details ?? null;
    throw err;
  }
  const parsed = extractor.final();
  // Anything the incremental pass missed (e.g. the last turn closed with the array).
  const turns = Array.isArray(parsed.turns) && parsed.turns.length ? parsed.turns : [];
  for (let i = emitted; i < turns.length; i++) onTurn?.(turns[i], i);

  return {
    turns,
    plan: cleanPlan(parsed.plan),
    interests: {
      topics: (parsed.interests?.topics ?? []).filter((t) => typeof t === "string"),
      entities: (parsed.interests?.entities ?? []).filter((t) => typeof t === "string"),
    },
    preferences: (parsed.preferences ?? []).filter(
      (p) => p && typeof p.label === "string" && (p.direction === "more" || p.direction === "less"),
    ),
    truncated: message.stop_reason === "max_tokens",
  };
}

function cleanPlan(plan) {
  if (!Array.isArray(plan)) return [];
  return plan
    .filter((p) => p && typeof p.title === "string" && typeof p.query === "string")
    .map((p) => ({
      title: p.title.trim().slice(0, 120),
      query: p.query.trim().slice(0, 300),
      why: typeof p.why === "string" ? p.why.trim().slice(0, 300) : "",
    }))
    .filter((p) => p.title && p.query);
}

const PLAN_RULES = `
"plan" is the rest of the episode: what the hosts will work through after this,
in order. Each item has a "title" (a short phrase a listener would see on screen —
not a sentence, not clickbait), a "query" (what to actually go and research, written
as a plain instruction with the subject named in full, because a search engine will
receive it with no other context), and "why" (one clause on what makes it worth the
listener's time on this podcast).

Every plan item must stay inside this episode's named facet. Adjacent facets belong
to later episodes of the series. Use the promised episode roadmap in THIS PODCAST
as the running order: cover its still-uncovered beats before inventing adjacent
ones. The sole exception is explicit caller steering, when the listener has
directly asked the hosts to follow another thread; that new direction wins.
`.trim();

/**
 * The top of the episode: a short welcome, in the hosts' voices, that shows the
 * listener their premise came through — and the plan for what follows.
 *
 * This runs before any research on purpose. It needs nothing but the premise, so
 * the listener hears a voice within a couple of seconds rather than waiting on a
 * search; the first researched segment is built while this is still playing.
 */
export function openingIntroduction(show) {
  const firstEpisode = Number(show.episodeNumber ?? 1) <= 1;
  const introduction = firstEpisode
    ? `
The listener just described the podcast they want in one spoken request. They have
never heard these hosts before.

Write exactly 4 concise turns, about one hundred and ten words in total, covering in order:

1. Ari immediately acknowledges the request with "That sounds great", announces
   the podcast by its exact title, "${show.title}", and introduces Ari and Dev.
2. Dev explains the exact episode, "${show.episodeTitle}", then paraphrases the
   roadmap below in plain conversational language. Describe the progression in
   thirty to forty-five words total; do not recite the labels verbatim.
   ROADMAP: ${(show.episodeOutline ?? []).join("; ")}.
3. Ari says how they will approach that facet and introduces Sam as their producer,
   without stating any fact about the subject.
4. Dev reminds the listener they can use Call in at any time, then hands into the
   episode focus without covering it.
`
    : `
This is episode ${show.episodeNumber} of an existing series. The listener did not
just make a new spoken request, and already knows the hosts.

Write exactly 4 concise turns, about one hundred and ten words in total, covering in order:

1. Ari welcomes the listener back to the podcast by its exact title, "${show.title}",
   and announces episode ${show.episodeNumber}, "${show.episodeTitle}".
2. Dev explains this episode's distinct focus, then paraphrases the roadmap below
   in plain conversational language. Describe the progression in thirty to
   forty-five words total; do not recite the labels verbatim.
   ROADMAP: ${(show.episodeOutline ?? []).join("; ")}.
3. Ari says how Ari, Dev, and producer Sam will approach that focus, without
   re-introducing anyone or stating any fact about the subject.
4. Dev reminds the listener they can use Call in at any time, then hands into the
   episode focus without covering it.

Do not say "that sounds great", thank the listener for a request, or imply they just
described the podcast. Do not give first-time host introductions.
`;
  return { firstEpisode, introduction: introduction.trim() };
}

export async function scriptOpening({ show, profileBrief, pacing = 0, onTurn }) {
  const { firstEpisode, introduction } = openingIntroduction(show);
  const prompt = `
This is the very top of a brand new episode — the first thing the listener hears.

The hosts are ${config.hosts.ari.name} and ${config.hosts.dev.name}.

${introduction}

Warm and quick. This listener asked for hosts who get to the point, and the first
thing they hear should prove it: no throat-clearing and nothing said twice.
${firstEpisode ? `Do not say "welcome back" — this is the first episode.` : ""}

Nothing has been researched yet. State no fact about the subject at all — no
number, no date, no measurement, no claim about how something works. Those belong
in the next segment, where they will have sources behind them. Naming the subject
is not a fact; saying anything about it is.

What we know about this listener: ${profileBrief}
`.trim();

  return streamScript({
    system: houseStyle(show),
    prompt,
    schema: OPENING_SCHEMA,
    maxTokens: 2000,
    onTurn,
  });
}

/** One planned subject, with its own research round already done. */
export async function scriptSegment({
  show,
  item,
  research,
  profileBrief,
  pacing = 0,
  recap,
  callerThread,
  memory = { heard: [], committed: [] },
  firstSegment = false,
  onTurn,
}) {
  const material = researchBlock(research);
  const prompt = `
Continue the episode. The hosts have just finished: ${recap || "the opening"}.
Move into the next subject with a real transition, not "moving on".

${callerThread ? `The episode is still following the thread the listener opened when they called in and said: "${callerThread}". The transition should come off that, not off a subject the hosts dropped earlier.` : ""}

SUBJECT: ${item.title}
WHY IT IS IN THIS EPISODE: ${item.why || "it fits the premise"}

${material || "No research came back for this subject in the time available. Say so plainly, keep it short, and hand on — do not fill the gap with invented detail."}

What we know about this listener: ${profileBrief}
${pacingBrief(pacing)}

FACT REPETITION BUDGET
- Confirmed heard by the listener: ${(memory.heard ?? []).join(" | ") || "nothing yet"}
- Already committed to the immediately preceding script: ${(memory.committed ?? []).join(" | ") || "nothing"}
Do not repeat a fact, comparison, number, date, or anecdote from either list. The
second list is script continuity only; never describe it as something the listener
heard. A brief transition may name the prior subject without restating its facts.

Ari leads from Ari's independently gathered packet, with concrete mechanisms,
chronology, and numbers. Dev contributes from Dev's independently gathered packet,
pressing on consequences, disagreement, and why it matters. If one packet is marked
unavailable, that host may ask or react but must not imply they researched a fact.
Sam may ask one very simple layperson's clarification, with no technical term,
research fact, or new number of Sam's own. Ari or Dev answers it from their notes.
${firstSegment ? "This is the first substantive segment. Include exactly one short, basic question from Sam so the listener meets the producer in the actual reporting." : "Sam's question is optional; omit it unless a basic clarification would materially help the listener."}
End on a beat that could hand to another subject — do not sign off.
`.trim();

  return streamScript({
    system: houseStyle(show),
    prompt,
    schema: SEGMENT_SCHEMA,
    maxTokens: 3000,
    onTurn,
  });
}

/**
 * What the hosts say the moment the caller stops talking, while the search for an
 * answer is still running underneath.
 *
 * This is a real part of the show and not filler. On a call-in programme the host
 * repeats the question back, reacts to it, and places it against what was just on
 * air — partly because it is warm, and partly because it is how a live broadcast
 * has always bought itself twenty seconds. It does both here.
 *
 * The one hard rule is that it contains no answer and no fact about the subject.
 * Nothing has been looked up yet.
 */
export async function scriptCallerCover({
  show,
  question,
  profileBrief,
  knownFor = [],
  recap,
  onTurn,
}) {
  const prompt = `
The listener is on the line and has just finished speaking. Nothing has been looked
up yet — the search is running while you write this.

They said, verbatim: "${question}"

What was on air when they called: ${recap || "the top of the episode"}
What we know about this listener: ${profileBrief}
${knownFor.length ? `Subjects they have asked about on this podcast before: ${knownFor.join(", ")}.` : ""}

Write 3 to 4 turns of the hosts taking the call, in this order:

1. React to it as people, not as a search box. Dev takes it first: acknowledge them,
   and say what makes the question a good one — specifically, not "great question".
2. Put the question back in the hosts' own words, so the caller can hear they were
   understood. Not a verbatim repeat.
3. Place it against what the hosts were just talking about, or against what this
   listener has asked about before if that is genuinely a connection worth naming —
   recognising a regular by what they follow is warm; guessing is not. Only do this
   if the material above actually supports it.
4. Say plainly that you are looking it up now, and hand into that.

ABSOLUTE RULE: do not answer any part of the question, and state no fact about its
subject — no number, no date, no name you were not given above, no "as I recall".
You do not know the answer yet. Saying so is the point of these lines.

"interests" is what THIS LISTENER has just shown they care about, judged from what
they asked. If they asked about a subject, that subject is a topic; a person or
organisation goes in "entities" only if the listener asked about them by name. When
in doubt leave both lists empty — getting this wrong pins strangers to someone's
profile.

"preferences" is for when they state what they want the show to cover rather than
asking about something: "less sports" is {label: "sports", direction: "less"},
"more of the technical stuff" is {label: "technical detail", direction: "more"}. A
plain question about a subject is not a preference — leave the list empty.
`.trim();

  return streamScript({
    system: houseStyle(show),
    prompt,
    schema: COVER_SCHEMA,
    maxTokens: 1800,
    onTurn,
  });
}

/**
 * The answer itself. Only ever called with research that cleared the usability
 * gate — there is no "say you don't know" branch in this prompt, because a model
 * asked to talk about a subject it was given nothing on will talk about it anyway.
 * That case never reaches here; the show layer reads fixed lines instead.
 */
export async function scriptCallerSegment({
  show,
  question,
  research,
  profileBrief,
  pacing = 0,
  recap,
  memory = { heard: [], committed: [] },
  planSize = 3,
  onTurn,
}) {
  const prompt = `
The hosts have already taken the call, read the question back, and said they were
looking it up. The search has now come back. This is the answer.

The listener asked, verbatim: "${question}"

${researchBlock(research)}

What we know about this listener: ${profileBrief}
What was on air when they called: ${recap || "the top of the episode"}
${pacingBrief(pacing)}

Do not repeat these confirmed-heard turns or facts: ${(memory.heard ?? []).join(" | ") || "nothing yet"}
Do not duplicate these facts already committed in the preceding script: ${(memory.committed ?? []).join(" | ") || "nothing"}

Open with the answer itself, in one short line — no re-greeting, no thanking them
again, no restating the question a second time. Then work through it properly and
let the episode turn in that direction.

Ground every claim in the material above. Where it does not cover something, say
that rather than filling it in. Ari and Dev must keep their independently labelled
research angles distinct. A host whose packet is unavailable cannot imply they
researched a fact. Sam may ask one short, basic layperson's clarification, but has
no research lane and must introduce no fact, number, or technical term. Ari or Dev
answers Sam from the sourced notes. Do not read out web addresses.

${PLAN_RULES}
Give ${planSize} plan items for the rest of the episode, re-planned around where
this listener has just taken it. Do not go back to what was queued before they called.
`.trim();

  return streamScript({
    system: houseStyle(show),
    prompt,
    schema: CALLER_SCHEMA,
    maxTokens: 3400,
    onTurn,
  });
}

/**
 * Turn what someone said out loud into a podcast.
 *
 * Nobody speaks in form fields. Asked what they want, a person says "the NFL, this
 * week's games, and I don't want hot takes" — one sentence carrying the subject,
 * the episode shape, and the angle. This pulls the three apart so the house style
 * has something to work with, and invents the missing ones when they only named a
 * subject, which is the common case.
 *
 * The one thing it must not do is add a subject they did not name.
 */
export async function derivePremise({ spoken }) {
  const said = String(spoken ?? "").trim().slice(0, 1200);
  const prompt = `
Someone was asked "what's your podcast about?" and answered out loud. This is the
transcript of what they said, which may be a fragment, may ramble, and may contain
speech disfluencies:

"${said}"

Turn it into a titled series and a focused first episode. Use their own words and
their own emphasis wherever they gave you any.

- "about": the subject, as a noun phrase. Lower case, no leading article needed.
  This is the thing they named — do not broaden it, narrow it, or substitute
  something adjacent to it.
- "episodes": the repeatable shape of episodes in this series. If they said, take
  it from them; otherwise write the natural series format in one clause.
- "angle": what makes this show different from any other on the same subject. If
  they said what they wanted or did not want, that is the angle. If they said
  nothing about it, write one that suits the subject — and keep it about how the
  hosts treat the material, not about the material itself.
- "title": a clever, memorable series title. Do not merely title-case the subject.
- "brief": one sentence that makes the series promise concrete.
- "episodeTitle": a crisp title for episode one.
- "episodeBrief": one sentence explaining what this episode will work through.
- "episodeFocus": the narrow facet that every planned topic in this episode must
  serve. If the listener explicitly supplied a facet, preserve it exactly in
  substance and do not replace it. If they only gave a broad subject, choose the
  most compelling narrow facet rather than surveying the whole subject. Example:
  "the moon landing" should make a series about the moon landing, while episode one
  focuses on the technology and mathematics that made the landing possible. If the
  request says "the Apollo Guidance Computer", that computer remains the focus.
  Write the focus as a standalone phrase that explicitly names the series subject;
  never rely on pronouns such as "they" or card context to identify what it means.
- "episodeOutline": only after the title, brief, and focus are settled, write 3 to
  5 concrete beats for this episode in the order the hosts should cover them. Each
  beat is a brief label or question of 6 to 12 words and under 100 characters. It
  names what to investigate without asserting the answer or conclusion. Every beat
  must be a specific part of the named focus, distinct from the others, and useful
  as a research subject. Together they should fulfill the episode brief without
  turning into a broad survey of the whole series.

Each field is a phrase or one sentence, written to be read as part of a brief to
the hosts. No quotation marks, no preamble, no addressing the listener.
`.trim();

  // Bounded like every other upstream in this app: the listener is looking at a
  // spinner on the first screen they ever see, and a model that hangs would leave
  // them there indefinitely.
  const message = await client.messages.create(
    {
      model: config.anthropic.model,
      max_tokens: 1100,
      thinking: { type: "disabled" },
      output_config: {
        effort: config.anthropic.effort,
        format: { type: "json_schema", schema: PREMISE_SCHEMA },
      },
      messages: [{ role: "user", content: prompt }],
    },
    { timeout: config.timeouts.premise },
  );
  if (message.stop_reason === "refusal") {
    const err = new Error("We can't build a show around that.");
    err.code = "REFUSAL";
    err.status = 422;
    throw err;
  }
  const text = message.content.find((c) => c.type === "text")?.text ?? "{}";
  let parsed = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    /* fall through to the transcript */
  }
  // The transcript is still the listener's own words, and losing them because a
  // split came back empty — schema-valid or not — would refuse a podcast someone
  // just described out loud. `defineShow` fills the other two fields in.
  return {
    about: String(parsed.about ?? "").trim() || said,
    episodes: String(parsed.episodes ?? "").trim(),
    angle: String(parsed.angle ?? "").trim(),
    title: String(parsed.title ?? "").trim(),
    brief: String(parsed.brief ?? "").trim(),
    episodeTitle: String(parsed.episodeTitle ?? "").trim(),
    episodeBrief: String(parsed.episodeBrief ?? "").trim(),
    episodeFocus: String(parsed.episodeFocus ?? "").trim(),
    episodeOutline: Array.isArray(parsed.episodeOutline)
      ? parsed.episodeOutline.filter((beat) => typeof beat === "string").map((beat) => beat.trim()).filter(Boolean)
      : [],
  };
}

/** Choose the next distinct facet without changing anything about the series. */
export async function deriveNextEpisode({ show }) {
  const previous = [
    ...(show.episodeHistory ?? []),
    {
      episodeTitle: show.episodeTitle,
      episodeBrief: show.episodeBrief,
      episodeFocus: show.episodeFocus,
    },
  ];
  const prompt = `
Plan one new episode of the existing podcast "${show.title}".

SERIES SUBJECT: ${show.about}
SERIES PROMISE: ${show.brief}
REPEATABLE EPISODE SHAPE: ${show.episodes}
SERIES ANGLE: ${show.angle}

Already used facets — do not repeat or lightly rename any of them:
${previous.map((item) => `- ${item.episodeFocus}: ${item.episodeTitle}`).join("\n")}

Return a crisp episodeTitle, a one-sentence episodeBrief, a narrow episodeFocus,
and then an episodeOutline of 3 to 5 concrete, distinct beats in running order.
Each beat is a brief label or question of 6 to 12 words and under 100 characters;
it names what to investigate without asserting an answer or conclusion. The focus
must be a genuinely different facet of the same series subject and must be specific
enough to govern every topic in the episode. Every outline beat must serve that
focus and be useful as a research subject. Do not turn a durable
historical or technical series into current affairs merely because the new episode
mentions something recent.
  `.trim();
  const message = await client.messages.create(
    {
      model: config.anthropic.model,
      max_tokens: 1000,
      thinking: { type: "disabled" },
      output_config: {
        effort: config.anthropic.effort,
        format: { type: "json_schema", schema: NEXT_EPISODE_SCHEMA },
      },
      messages: [{ role: "user", content: prompt }],
    },
    { timeout: config.timeouts.premise },
  );
  if (message.stop_reason === "refusal") {
    const err = new Error("We couldn't find the next episode of this podcast.");
    err.code = "REFUSAL";
    err.status = 422;
    throw err;
  }
  const text = message.content.find((c) => c.type === "text")?.text ?? "{}";
  try {
    const parsed = JSON.parse(text);
    return {
      episodeTitle: String(parsed.episodeTitle ?? "").trim(),
      episodeBrief: String(parsed.episodeBrief ?? "").trim(),
      episodeFocus: String(parsed.episodeFocus ?? "").trim(),
      episodeOutline: Array.isArray(parsed.episodeOutline)
        ? parsed.episodeOutline.filter((beat) => typeof beat === "string").map((beat) => beat.trim()).filter(Boolean)
        : [],
    };
  } catch {
    return {};
  }
}

/** Plan more of the episode once the queue runs dry. Structured, no dialogue. */
export async function replanEpisode({
  show,
  profileBrief,
  covered = [],
  seeds = [],
  direction = null,
  planSize = 4,
}) {
  const prompt = `
The hosts need the next stretch of this episode planned.

${covered.length ? `Already covered this episode — do not repeat any of these:\n${covered.map((c) => `- ${c}`).join("\n")}` : "Nothing has been covered yet."}

${direction ? `The listener called in and steered the episode here: "${direction}". Keep following that thread.` : ""}

${direction ? "Caller steering replaces the original roadmap for this re-plan." : `Promised roadmap, in order. Cover every beat that is not already represented in the covered list:\n${(show.episodeOutline ?? []).map((beat) => `- ${beat}`).join("\n")}`}

${seeds.length ? `Candidate subjects, pulled live and already screened for scale and for being carried by national outlets:\n${storyBlock(seeds)}\n\nPick the ones that would matter to a general audience. Skip anything local, procedural, or grim-but-inconsequential just because it is recent.` : ""}

What we know about this listener: ${profileBrief}

${PLAN_RULES}
Give exactly ${planSize} items, ordered strongest first. No dialogue.
`.trim();

  const message = await client.messages.create({
    model: config.anthropic.model,
    max_tokens: 1200,
    thinking: { type: "disabled" },
    output_config: { effort: config.anthropic.effort, format: { type: "json_schema", schema: REPLAN_SCHEMA } },
    system: houseStyle(show),
    messages: [{ role: "user", content: prompt }],
  });
  if (message.stop_reason === "refusal") {
    const err = new Error("The model declined to plan this episode.");
    err.code = "REFUSAL";
    throw err;
  }
  const text = message.content.find((c) => c.type === "text")?.text ?? "{}";
  try {
    return cleanPlan(JSON.parse(text).plan);
  } catch {
    return [];
  }
}
