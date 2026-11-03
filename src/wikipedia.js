import { config } from "./config.js";
import { fetchWithTimeout, readBody } from "./http.js";

/**
 * Wikipedia background, via the Action API's plaintext extracts.
 *
 * `generator=search` runs the search and hydrates the matching pages in one round
 * trip, and `explaintext` returns the lead section as prose — so nothing here ever
 * parses HTML. `inprop=url` gives the canonical page link for the sources rail.
 *
 * Wikipedia's policy asks for a User-Agent that identifies the client and gives a
 * way to make contact; requests without one are throttled or refused.
 */
const endpoint = () => config.wikipedia.url;

export const USER_AGENT =
  process.env.NEWSCAST_USER_AGENT ||
  "longtime-listener/0.2 (https://github.com/Plynth-Labs/longtime-listener)";

/**
 * @returns {Promise<Array<{title: string, extract: string, url: string}>>}
 *   Empty rather than throwing: Wikipedia is one of several sources behind a
 *   shared deadline, and a background read is never a reason to lose the segment.
 */
export async function wikiLookup(query, { limit = 3, chars = 1200, timeoutMs } = {}) {
  const term = String(query ?? "").trim().slice(0, 300);
  if (!term) return [];

  const params = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    generator: "search",
    gsrsearch: term,
    gsrlimit: String(limit),
    gsrnamespace: "0", // articles only — no talk pages or project scaffolding
    prop: "extracts|info",
    exintro: "1",
    explaintext: "1",
    exlimit: "max", // without this only the first generated page gets an extract
    exchars: String(chars),
    inprop: "url",
    redirects: "1",
  });

  const res = await fetchWithTimeout(
    `${endpoint()}?${params}`,
    { headers: { "user-agent": USER_AGENT, accept: "application/json" } },
    timeoutMs ?? config.timeouts.wikipedia,
  );
  if (!res.ok) throw new Error(`Wikipedia ${res.status}`);
  const json = await readBody(res, "json");

  const pages = json?.query?.pages ?? [];
  return pages
    .filter((p) => p && !p.missing && typeof p.extract === "string" && p.extract.trim())
    .map((p) => ({
      title: p.title,
      // The API's ellipsis marker is a literal "..." appended to a truncated
      // extract; it reads badly aloud and worse in a prompt.
      extract: p.extract.replace(/\s*\.\.\.\s*$/, "").trim(),
      url: p.canonicalurl || p.fullurl || `https://en.wikipedia.org/wiki/${encodeURIComponent(p.title)}`,
    }))
    .slice(0, limit);
}
