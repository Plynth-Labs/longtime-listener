// Which publications the show is willing to lean on.
//
// Two jobs. The web search is handed an allow-list so it never comes back with a
// content farm, and wire stories are screened against the same list so a local
// crime story that only ever ran in one outlet cannot lead the episode. The
// screening is on the *domain*, not on a headline: "carried by AP and Reuters" is
// a fact about a story, "sounds important" is not.
//
// The OpenAI web_search tool accepts at most 20 allowed domains, so each list is
// kept inside that on its own and `domainsFor` truncates the merge.
const MAX_DOMAINS = 20;

// Wire services and national desks an American general-interest listener would
// recognise. A story none of these touched is, for this show's purposes, not a
// big story.
export const MAJOR_NEWS = [
  "apnews.com",
  "reuters.com",
  "npr.org",
  "bbc.com",
  "nytimes.com",
  "wsj.com",
  "washingtonpost.com",
  "ft.com",
  "cnn.com",
  "foxnews.com",
  "nbcnews.com",
  "cbsnews.com",
  "abcnews.go.com",
  "politico.com",
  "axios.com",
  "bloomberg.com",
  "theguardian.com",
  "usatoday.com",
  "pbs.org",
  "economist.com",
];

export const SPORTS = [
  "espn.com",
  "nfl.com",
  "theathletic.com",
  "si.com",
  "cbssports.com",
  "nbcsports.com",
  "profootballfocus.com",
  "sports.yahoo.com",
  "apnews.com",
  "reuters.com",
];

export const TECH = [
  "arstechnica.com",
  "theverge.com",
  "wired.com",
  "techcrunch.com",
  "nature.com",
  "science.org",
  "spectrum.ieee.org",
  "technologyreview.com",
  "reuters.com",
  "apnews.com",
];

export const SCIENCE = [
  "nasa.gov",
  "science.org",
  "nature.com",
  "scientificamerican.com",
  "space.com",
  "esa.int",
  "noaa.gov",
  "nih.gov",
  "smithsonianmag.com",
  "quantamagazine.org",
];

export const REFERENCE = [
  "en.wikipedia.org",
  "britannica.com",
  "loc.gov",
  "archives.gov",
  "si.edu",
  "history.com",
  "jstor.org",
  "nationalgeographic.com",
];

const FAMILIES = {
  news: MAJOR_NEWS,
  sports: SPORTS,
  tech: TECH,
  science: SCIENCE,
  reference: REFERENCE,
};

/**
 * The allow-list for one show. `families` comes from the preset (or is inferred
 * from what the listener wrote); an unrecognised family is ignored rather than
 * fatal, and an empty result means "search the open web" — which is what a show
 * about something none of these lists covers actually wants.
 *
 * The merge is round-robin, not concatenation. Twenty domains is the tool's
 * ceiling, and the news list alone fills it: appending would mean a show about
 * football searching twenty newspapers and not one sports desk.
 */
export function domainsFor(families = []) {
  const lists = families.map((f) => FAMILIES[f]).filter(Boolean);
  const out = [];
  for (let i = 0; out.length < MAX_DOMAINS; i++) {
    let exhausted = true;
    for (const list of lists) {
      if (i >= list.length) continue;
      exhausted = false;
      if (!out.includes(list[i])) out.push(list[i]);
      if (out.length >= MAX_DOMAINS) break;
    }
    if (exhausted) break;
  }
  return out;
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Does this URL sit on `domain`, or on a subdomain of it? */
export function onDomain(url, domain) {
  const host = hostOf(url);
  if (!host) return false;
  return host === domain || host.endsWith(`.${domain}`);
}

export function isMajorNews(url) {
  return MAJOR_NEWS.some((d) => onDomain(url, d));
}

/** How many of a story's source links are major national outlets. */
export function majorSourceCount(story) {
  return (story.sources ?? []).filter((url) => isMajorNews(url)).length;
}

/** Pretty name for a domain, for the "who is reporting this" line in the UI. */
const NAMES = {
  "apnews.com": "AP",
  "reuters.com": "Reuters",
  "npr.org": "NPR",
  "bbc.com": "BBC",
  "nytimes.com": "The New York Times",
  "wsj.com": "The Wall Street Journal",
  "washingtonpost.com": "The Washington Post",
  "ft.com": "Financial Times",
  "cnn.com": "CNN",
  "foxnews.com": "Fox News",
  "nbcnews.com": "NBC News",
  "cbsnews.com": "CBS News",
  "abcnews.go.com": "ABC News",
  "politico.com": "Politico",
  "axios.com": "Axios",
  "bloomberg.com": "Bloomberg",
  "theguardian.com": "The Guardian",
  "usatoday.com": "USA Today",
  "pbs.org": "PBS",
  "economist.com": "The Economist",
  "espn.com": "ESPN",
  "nfl.com": "NFL.com",
  "theathletic.com": "The Athletic",
  "si.com": "Sports Illustrated",
  "en.wikipedia.org": "Wikipedia",
};

export function outletName(url) {
  const host = hostOf(url);
  if (!host) return null;
  return NAMES[host] ?? host;
}
