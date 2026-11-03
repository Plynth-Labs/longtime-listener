import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Keys come from the environment. A .env file at the repo root fills in what
// the environment leaves unset; a variable already exported always wins.
if (fs.existsSync(path.join(root, ".env"))) process.loadEnvFile(path.join(root, ".env"));

const num = (v, fallback) => (v === undefined || v === "" ? fallback : Number(v));

export const DEFAULT_NEWSMCP_URL = "https://mcp.newsmcp.com/mcp";

export const config = {
  root,
  dataDir: process.env.NEWSCAST_DATA_DIR || path.join(root, "data"),
  port: num(process.env.PORT, 4310),
  host: process.env.HOST || "127.0.0.1",

  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    // Overridable for a gateway, and so the offline suite can point it at a closed
    // port — which is what lets a test tell "the research gate stopped us" apart
    // from "the script was attempted and failed".
    baseUrl: process.env.ANTHROPIC_BASE_URL || undefined,
    // Dialogue generation. Thinking is disabled and effort is low because the
    // script has to be ready before the previous segment finishes playing;
    // structured outputs keep the response schema-valid without thinking.
    model: process.env.NEWSCAST_MODEL || "claude-opus-5",
    effort: process.env.NEWSCAST_EFFORT || "low",
  },

  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    // Overridable so a proxy or gateway can front these calls — and so the offline
    // test suite can point every one of them at a closed port and stay offline.
    baseUrl: (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, ""),
    ttsModel: process.env.NEWSCAST_TTS_MODEL || "gpt-4o-mini-tts",
    transcribeModel: process.env.NEWSCAST_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe",
    // Research for every segment and every call-in. This model is chosen for one
    // capability: `web_search.filters.allowed_domains`, which is how the show is
    // held to real publications. The 4.1 family rejects that filter outright, so
    // downgrading the model here silently removes the outlet floor.
    researchModel: process.env.NEWSCAST_RESEARCH_MODEL || "gpt-5.4-mini",
    researchEffort: process.env.NEWSCAST_RESEARCH_EFFORT || "low",
    // Sent to the search tool so "this weekend" and "here" mean what the listener
    // means. Overridable for a listener who is not on the US west coast.
    country: process.env.NEWSCAST_COUNTRY || "US",
    timezone: process.env.NEWSCAST_TIMEZONE || "America/Los_Angeles",
  },

  // Bounded waits. Every upstream sits behind a queue, so a hang is a stall.
  timeouts: {
    newsmcp: num(process.env.NEWSCAST_TIMEOUT_NEWSMCP, 20000),
    tts: num(process.env.NEWSCAST_TIMEOUT_TTS, 30000),
    transcribe: num(process.env.NEWSCAST_TIMEOUT_TRANSCRIBE, 30000),
    wikipedia: num(process.env.NEWSCAST_TIMEOUT_WIKIPEDIA, 8000),
    // The listener is watching a spinner on the first screen they ever see.
    premise: num(process.env.NEWSCAST_TIMEOUT_PREMISE, 20000),
    // The measured domain-filtered search lands in about seven seconds; this is
    // the ceiling before the hosts go to air with whatever else arrived.
    research: num(process.env.NEWSCAST_TIMEOUT_RESEARCH, 22000),
  },

  wikipedia: {
    // Overridable for the same reason the OpenAI base URL is: the offline suite
    // points it at a closed port so `npm run check` makes no network calls at all.
    url: process.env.WIKIPEDIA_API_URL || "https://en.wikipedia.org/w/api.php",
  },

  newsmcp: {
    url: process.env.NEWSMCP_URL || DEFAULT_NEWSMCP_URL,
    apiKey: process.env.NEWSMCP_API_KEY || null,
    // Keyless ceiling is 20 calls/hour shared per network address, concurrency 1.
    hourlyBudget: num(process.env.NEWSMCP_HOURLY_BUDGET, 20),
    // Calls held back for live call-ins so a headline refresh can never starve them.
    callInReserve: num(process.env.NEWSMCP_CALLIN_RESERVE, 8),
    headlineTtlMs: num(process.env.NEWSMCP_HEADLINE_TTL_MS, 25 * 60 * 1000),
    searchTtlMs: num(process.env.NEWSMCP_SEARCH_TTL_MS, 10 * 60 * 1000),
    storyLimit: num(process.env.NEWSMCP_STORY_LIMIT, 20),
    // A story no national outlet carried is not a lead story. Both floors have to
    // clear for a wire headline to reach the episode planner.
    minMajorSources: num(process.env.NEWSCAST_MIN_MAJOR_SOURCES, 1),
    minNewsrooms: num(process.env.NEWSCAST_MIN_NEWSROOMS, 6),
  },

  episode: {
    // How many topics the hosts plan ahead. Small: a caller re-plans the rest of
    // the episode, so a long plan is mostly work that gets thrown away.
    planSize: num(process.env.NEWSCAST_PLAN_SIZE, 4),
  },

  hosts: {
    ari: {
      name: "Ari",
      voice: process.env.NEWSCAST_VOICE_ARI || "ash",
      persona:
        "Ari is a dry, precise investigative host who brings independently researched " +
        "mechanisms, chronology, and numbers; keeps the episode moving and can disagree without posturing.",
      delivery:
        "Measured broadcast host. Clear consonants, unhurried, warm but not chatty. " +
        "Slight downward inflection at the end of statements.",
    },
    dev: {
      name: "Dev",
      voice: process.env.NEWSCAST_VOICE_DEV || "sage",
      persona:
        "Dev is an independently informed co-host who brings concrete reporting on consequences, " +
        "people, and disputes; connects the subject to the listener's world and challenges Ari when the evidence supports it.",
      delivery:
        "Conversational public-radio co-host. A little brighter and faster than the host, " +
        "leans into questions, natural pauses mid-thought.",
    },
    producer: {
      name: "Sam",
      voice: process.env.NEWSCAST_VOICE_PRODUCER || "coral",
      persona:
        "Sam is the producer and listens like a curious layperson without a research packet. " +
        "Occasionally asks one short, basic clarification such as ‘Why did that matter?’ or " +
        "‘What does that mean?’ Sam never introduces technical terms, facts, or numbers and never behaves like a third host.",
      delivery:
        "Calm producer speaking briefly from the control room. Crisp, curious, and economical, " +
        "with a natural questioning lift and no announcer voice.",
    },
  },
};

export function assertKeys() {
  const missing = [];
  if (!config.anthropic.apiKey) missing.push("ANTHROPIC_API_KEY");
  if (!config.openai.apiKey) missing.push("OPENAI_API_KEY");
  if (missing.length) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}. ` +
        `Copy .env.example to .env and fill them in, or export them (see README.md).`,
    );
  }
}
