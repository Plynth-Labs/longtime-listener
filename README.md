# Longtime Listener

A podcast you can call into, starting with one topic.

The first screen asks what your first podcast should be about. Tap the microphone
and speak, or type your idea. One answer creates a named series, a description,
and a focused first episode with a rough outline. Then the app switches to the
listening room, with **Pause** and **Call in** at the bottom. The hosts introduce
themselves and explain what to expect while research runs.

A broad request such as “the moon landing” becomes a series about that subject,
with an episode exploring one facet. If you ask for a specific facet, the hosts
follow it. The series title, episode title and brief stay above the transcript
while the discussion moves. **New episode** continues the series; **New podcast**
lets you choose a different subject.

**My podcasts** groups your saved episodes by podcast. Continue where you left
off or play an episode from the beginning. Share creates a link to a saved copy;
its listeners start at the beginning, and their call-ins create their own version.
The original stays intact. A branch stays under its podcast and identifies the
episode it came from.

Episodes save as the hosts speak, including the transcript and original audio.
Your library is tied to this browser's listener ID, with no account sign-in yet.
Keep that browser storage to retain access to your library. A shared link grants
access to that episode, including any recorded call-ins in it.

Ari and Dev bring separate research and different interests to the conversation.
Sam, the producer, asks short questions as a curious layperson. Call in to ask
for clarification or take them in a new direction. Every answer gets fresh
research, and an empty research result cannot become a factual script.

Source links are kept by the backend but hidden in the listening UI. Pace buttons
are also hidden; you can ask the hosts to slow down, move on or dig deeper by
calling in. Speech plays slightly faster at 1.12× with pitch preserved. All three
voices are AI-generated. Browsers that block playback show a Start listening
control in the episode dock.

Try it: https://drop.jonomatus.ky/longtime-listener/

## Quick start

You need Node.js 20.12 or newer, an Anthropic API key and an OpenAI API key.

```sh
git clone https://github.com/Plynth-Labs/longtime-listener.git
cd longtime-listener
npm install
cp .env.example .env      # then paste your two keys into .env
npm start
```

Then open <http://127.0.0.1:4310/>. Episodes, profiles and the speech cache are
saved under `./data`; set `NEWSCAST_DATA_DIR` to keep them somewhere else, and
back that directory up as a whole. Audio is part of a saved episode, not
disposable cache.

`bin/newscast --stub-wire` runs the news preset against invented stories instead of
the real wire — use it for interface work, because the keyless news budget is small
and shared (see below). The page shows a red banner whenever it is running on the
stub, so demo copy can never be mistaken for the news. Every other preset is
unaffected: they do not use the wire at all.

Keys can also be exported in your shell instead of written to `.env`; an exported
variable always wins over the file. Set `NEWSCAST_USER_AGENT` to a string with
your own contact address, as Wikipedia's API policy asks.

### Serving it under a path

The client resolves the API relative to its own URL, so mounting the app at
`/newscast/` behind a proxy works with no configuration. If the proxy does *not*
strip the prefix, set `BASE_PATH=newscast` and the server will mount there itself.

### The public demo

The demo page is a static bundle of `public/` hosted at
https://drop.jonomatus.ky/longtime-listener/, talking to a backend container on
Fly. The old `/long-time-listener/` address is a small browser redirect kept in
`redirects/long-time-listener/index.html`; it preserves query parameters and
fragments, with an HTML refresh and a visible link as fallbacks.

To build a static bundle against your own backend, pass an empty output
directory, the backend's API base and the path the page will live at
(default `/`):

```sh
node scripts/public-bundle.mjs ./public-bundle https://your-app.fly.dev/api/ /longtime-listener/
```

Host the result anywhere that serves static files, and set
`NEWSCAST_PUBLIC_ORIGIN` on the backend to that page's origin.

The gateway has global and per-client request limits, six concurrent generation
requests, 64 total concurrent requests, a 12 MB upload cap, and a two-minute
request deadline. Empty playback polls consume no generation budget. Delivered
segments and generation requests share an hourly cap — 240 global and 120 per
client by default, overridable with `NEWSCAST_PUBLIC_MAX_WORK_PER_HOUR` and
`NEWSCAST_PUBLIC_MAX_CLIENT_WORK_PER_HOUR`. This ceiling is the only thing
between an unauthenticated page and the provider bill, so the deployed instance
sets it lower than the default rather than inheriting it.
This is a public prototype with bounded capacity, not an authenticated service.
Saved playback and owner archive operations do not spend generation capacity.
Opening a shared episode allocates a studio session and counts toward admission
limits, as do call-ins and new episodes. The replay endpoint refuses live shows.
Listener profiles are stored server-side and tied to the browser’s listener ID;
other scripts hosted on the same origin as the page can access that browser storage.

Per-client limits key on the address the edge proxy reports, named by
`NEWSCAST_PUBLIC_CLIENT_IP_HEADER` (`fly-client-ip` on Fly). Never point it at
`X-Forwarded-For`: callers write that header themselves. Without the setting,
the gateway keys on the socket address. IPv6 callers count as one client per
`/64`. A full client table evicts the least recently seen idle caller rather
than turning newcomers away. POSTs must carry the page's `Origin`; GETs without
one pass, because a prefetching `<audio>` element sends none. None of this is
authentication — the global hourly ceiling is what bounds the bill.

An archive retains its original audio keys. `data/cache/tts` is permanent audio
storage for this prototype and has no eviction job. Missing original audio is
reported explicitly; it is not silently regenerated in another voice or model.
For migration from the old in-memory server, `scripts/import-episodes.mjs` accepts
a captured show JSON, its audio directory and a target data directory. It verifies
every audio file before publishing an episode and reuses the same archive ID on
repeat imports.

### Deploying the backend

`Dockerfile` and `fly.toml` deploy the container to Fly. `scripts/serve-public.mjs`
runs both processes: the app bound to `127.0.0.1:4310` and the gateway on
`0.0.0.0:8080`. The app is never bound to a routable address, so the gateway
stays the only way in — the same split as running it locally.

The demo runs as Fly app `longtime-listener` in `sjc`, serving
`https://longtime-listener.fly.dev`, with a 3 GB volume named `newscast_data`.
A new deployment needs its own app name: set `app` in `fly.toml`, then:

```sh
fly apps create <your-app> --org <your-org>
fly volumes create newscast_data --app <your-app> --region sjc --size 3 --yes
fly secrets set --app <your-app> ANTHROPIC_API_KEY=... OPENAI_API_KEY=...
fly deploy --app <your-app>
```

Then rebuild the static bundle against the deployed host and republish it at the
same address, so the public URL never changes.

The gateway is the only thing bound to a routable address, so `fly.dev` serves
`/api/`, `/health` and `/ready` and nothing else — the static app is hosted separately. Moving
durable data onto the volume is a `fly sftp put` of a tarball plus a `tar -xzf`
over `fly ssh console`; verify it by comparing SHA-256 across all files rather
than trusting the byte count.

Four deployment details are load-bearing:

- **`kill_timeout` must stay above 40s.** The app flushes open archives on
  SIGTERM and allows itself 35 seconds; the supervisor waits 40. A shorter
  platform timeout loses a saved episode on every machine stop.
- **The volume only grows.** `data/cache/tts` is permanent storage with no
  eviction job, and archives reference their audio by key, so nothing can be
  pruned without first proving no saved episode points at it. Boot-time warmup
  alone writes 21 files; watch `fly volumes list` rather than assuming headroom.
- **The hourly ceiling lives on the volume too**, at the path in
  `NEWSCAST_PUBLIC_BUDGET_FILE`. Machines are allowed to stop when idle, and a
  ceiling held in memory would reset on every restart — turning an hourly limit
  into a per-burst one that refills as often as someone is willing to wait. Per
  client counters are still in memory: they bound one address, the global window
  bounds the bill.
- **The platform health check is `/ready`, not `/health`.** `/health` only proves
  the gateway process is alive, and the platform keeps routing to whatever passes
  its check, so a hung app behind a healthy gateway would serve 502s to everyone.
  `/ready` probes the app. Neither path spends admission budget.

Machines auto-stop when idle and start on the next request. That is safe here
because the boot-time speech warmup reads the volume instead of re-rendering: a
cold start with the speech provider unreachable still completes its warmup, so
an idle instance costs nothing and wakes without spending API budget.

## How an episode is built

1. **One request creates the brief.** The model names the series and chooses a
   focused episode, including its title, description and ordered 3–5 beat outline.
   Explicit listener requests take precedence over inferred angles. Definitions
   keep both series and episode metadata; changing an episode does not change the
   series' profile scope.
2. **Research starts during setup.** An opaque research ID ties the work to the
   specific request. The first segment can consume it once if its subject and
   source rules match. A replaced or abandoned request cannot donate research to
   the next podcast.
3. **A short opening introduces the show.** The hosts acknowledge the request,
   name the podcast and themselves, explain the episode and remind the listener
   that they can call in. The opening states no unresearched facts. A brief reminder
   can follow a segment after five minutes of completed listening, then at least
   eight minutes apart. Calling in suppresses further reminders for the episode.
4. **Ari and Dev research different angles in parallel.** Each packet records
   which material is usable. A failed lane contributes no unsupported claims.
   The producer asks occasional basic questions from the listener’s perspective;
   Ari and Dev answer them from their research.
5. **Dialogue memory reduces repetition.** Completed speech is distinguished
   from the script immediately preceding a segment. Canceled future material is
   excluded, and a new episode resets the dialogue context.
6. **Speech streams one turn at a time.** A complete dialogue turn goes to speech
   generation while the model writes the next one. The client fetches the next
   turn's audio while the previous turn plays.

## Nothing is said without a source behind it

Two web searches once timed out at twenty-two seconds. The round returned
successfully with nothing in it, the hosts were handed a subject and a prompt
saying "answer from what you do have", and they invented it.

A prompt is not a gate, so this is one. Research counts as usable only if it came
back with text *and* an `http(s)` link behind it — an uncited summary is the model
talking from memory with a search tool attached, and by the time it reaches a
script it is indistinguishable from reporting. For a show that claims to cover the
last forty-eight hours, Wikipedia is background and not evidence.

Without that, the show layer does not call the model at all. It reads fixed lines
saying the search did not come back, leaves the subject uncovered so it can be
tried again, and moves on. Asking a model to say "I don't know" instead is not a
fix: saying it convincingly and inventing the answer are the same capability.

Every round gets one retry, at half the deadline, before it gives up.

## Calling in

The order matters, and it is the order a real call has:

| | what happens | why |
|---|---|---|
| You tap | the board lights up; the microphone permission prompt goes up | the hosts keep talking through it — nothing on air is disturbed yet |
| Permission settles | the recorder is *constructed*, not started | so the cue never arrives ahead of something able to record |
| The hosts hand over | "caller, you're on" plays to its end | this is the invitation, and it is a host line like any other |
| That line ends | the recorder starts, then the red cue appears | started before the progress report goes out, because that is a network round trip and a phone loses your first words to it |
| You tap Done | the recording goes straight to the hosts | no read-it-back step; what was heard appears in the transcript |
| Immediately | a pre-rendered line, then the hosts' own reaction | the question read back, why it's a good one, how it fits what they were just on — written without research, so it starts in seconds |
| Underneath | the search runs, with one retry | the reaction is what that time is made of; if it still fails, they say so rather than answering |

Hanging up at any point closes the microphone, cancels the answer and the hold line,
and — only if the hosts already announced you out loud — has them say they lost you.

## What the show holds onto

The visible listening controls are Pause/Resume and Call in. The earlier Hurry up
and Dive deeper controls are hidden, while existing pacing preferences and
feedback endpoints remain compatible with saved profiles.

`data/profiles/<listener>.json`, editable from the profile panel:

- **Interests**, which only ever come from something deliberate: what you asked
  about on air, what you told the hosts you wanted, what you added by hand, what
  you asked to go deeper on. Every entry records which of those it was, and the
  panel says so.
- **Interests belong to the podcast you were on.** One profile spans every show
  you set up, but calling in about the Eagles on a football podcast does not put
  the Eagles in a podcast about history — you changed the subject, deliberately,
  by making a different show. Go back to the football one and it all returns; the
  panel lists the rest under *From your other podcasts*, and asking about any of
  them here moves it across.

  A podcast is identified by its subject, not by when it was made, so setting the
  same one up again next week keeps what it learned, and rewriting the angle of a
  show about the NFL leaves it a show about the NFL.

  The asymmetry is deliberate: **promotion is scoped, suppression is not.** What
  you asked to hear *less* of, and how fast you want to be talked to, follow you
  everywhere — both of those can only ever take something away.
- **Listening is not a signal.** An earlier version learned every proper noun in
  every script it read out, which is how strangers ended up pinned to a profile.
  Those entries are kept and shown — they are the listener's data — but they are
  labelled as unexplained, they do not steer what gets picked, and they are ranked
  separately so they cannot crowd out anything you actually asked for.
- **Stated preferences.** "Less sports" lowers sports and mutes it. It does not
  learn an interest in sports because the word came up.
- **Covered subjects**, so an episode does not repeat itself.

Scores decay with a three-week half-life, so an old obsession does not own the show.

## The news preset and the wire budget

Only a podcast that is actually about the news touches NewsMCP, and only to find
candidate headlines. Keyless NewsMCP allows **20 calls an hour, shared across
everyone on your network address**, one request in flight at a time. So:

- A whole episode — welcome, several segments, one call-in — costs **at most 2
  calls**, and a podcast about anything else costs **none**. Both are asserted by
  `npm run wire-budget` against a local stub.
- Headlines are screened before the planner sees them: carried by at least one
  national outlet, and picked up by enough newsrooms to be more than a local item.
  That is the only thing the corroboration count is used for, and it never reaches
  the script — "forty newsrooms carried it" is not a fact about the world.
- The same screen applies to a caller's subject search, so it cannot be used as a
  way around the floor.
- Calls are serialized, cached, and re-checked against the live allowance inside the
  queue slot, so two callers cannot both miss the cache and both spend.
- When the budget is gone the hosts say so. Nothing invents stories to fill air.

`GET /api/status` reports `remaining`, `spentByUs`, and whether the figure is the
wire's own count or just this process's tally — a gap between the two means other
clients on your address are spending it.

## Where the research comes from

`src/outlets.js` holds the allow-lists the web search is held to, chosen per show
from what the listener wrote. A show it cannot classify searches the open web,
which is the right answer for a podcast about eighteenth-century clockmaking and
the wrong one for a podcast about today.

The search runs on a model that supports `web_search.filters.allowed_domains` — the
4.1 family rejects that filter outright, so changing `NEWSCAST_RESEARCH_MODEL` to
one of those silently removes the only guarantee that the reporting came from
somewhere real.

## Layout

| Path | What it holds |
|---|---|
| `server.js` | HTTP surface, the listener/segment routes, setup and call routes |
| `src/showdef.js` | Series and episode definitions, presets, classification, storage |
| `src/show.js` | The showrunner: episode plan, segment queue, calls, pacing |
| `src/research.js` | Parallel host research packets: web search, Wikipedia, and the wire |
| `src/outlets.js` | Which publications each kind of show is held to |
| `src/wikipedia.js` | Plaintext extracts via the Action API |
| `src/newsmcp.js` | Wire client: serialization, budget, cache, story screening |
| `src/llm.js` | Script generation, the episode planner, the streaming turn reader |
| `src/tts.js` | Speech, disk-cached by content hash; transcription |
| `src/profile.js` | Listener profile: provenance, pacing, serialized writes |
| `public/` | The client — no build step |
| `scripts/public-gateway.mjs` | The public API gateway: origin, admission and spend limits |

## Tests

See [TESTING.md](TESTING.md) for what each suite covers and the manual checks
worth doing before a release.

```sh
npm run check         # offline: races, call flow, screening, the client's contracts
npm run wire-budget   # counts wire calls for a full episode against a stub
npm run e2e           # live end to end — spends real quota
```

`npm run check` is the one to run constantly; it makes no network calls at all.
`npm run e2e` drives two podcasts — one custom subject, one news preset — with real
audio, and asserts the interruption behaviour; it costs about 1 wire call.

## Configuration

Everything has a working default. The ones worth knowing:

| Variable | Default | Notes |
|---|---|---|
| `PORT` / `HOST` | `4310` / `127.0.0.1` | |
| `BASE_PATH` | none | Set if a proxy does not strip the path prefix |
| `NEWSCAST_MODEL` | `claude-opus-5` | Thinking is off and effort is low: the script has to land before the segment on air ends, and structured outputs keep the shape valid without a reasoning pass |
| `NEWSCAST_RESEARCH_MODEL` | `gpt-5.4-mini` | Must support `web_search.filters.allowed_domains` |
| `NEWSCAST_COUNTRY` / `_TIMEZONE` | `US` / `America/Los_Angeles` | So "this weekend" and "here" mean what the listener means |
| `NEWSCAST_TIMEOUT_PREMISE` | `20000` | Ceiling on working out a show from what was said |
| `OPENAI_BASE_URL` | the live API | Point at a gateway, or at a closed port to force offline |
| `ANTHROPIC_BASE_URL` / `WIKIPEDIA_API_URL` | the live APIs | Same; the offline suite points all four at a closed port |
| `NEWSCAST_VOICE_ARI` / `_DEV` / `_PRODUCER` | `ash` / `sage` / `coral` | Voices for Ari, Dev, and Sam |
| `NEWSCAST_PLAN_SIZE` | `4` | Subjects planned ahead; a caller re-plans the rest anyway |
| `NEWSCAST_MIN_NEWSROOMS` | `6` | Scale floor for a wire headline |
| `NEWSCAST_MIN_MAJOR_SOURCES` | `1` | National-outlet floor for a wire headline |
| `NEWSMCP_API_KEY` | none | A key raises the hourly ceiling and the lookback window |
| `NEWSMCP_CALLIN_RESERVE` | `8` | Calls held back for live call-ins |
| `NEWSMCP_URL` | the live wire | Point at `scripts/stub-wire.mjs` for demos |
| `NEWSCAST_DATA_DIR` | `./data` | Profiles, show definitions, and the speech cache |

## License

MIT — see [LICENSE](LICENSE).
