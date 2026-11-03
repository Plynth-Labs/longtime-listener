# Testing

Three suites, from free to paid.

| Command | Network | What it proves |
|---|---|---|
| `npm run check` | none | Races, the call-in flow, story screening, the client's contracts, the saved library, and the public gateway's limits |
| `npm run wire-budget` | local stub only | A full news episode spends at most two NewsMCP calls; any other podcast spends none |
| `npm run e2e` | live APIs | Two podcasts end to end with real audio, including an interruption; costs real provider quota and about one wire call |

Run `npm run check` constantly. It points every provider at a closed port, so
a test can tell "the research gate stopped us" apart from "the script was
attempted and failed". It needs no keys.

## The public gateway

`scripts/public-gateway.test.mjs` runs inside `npm run check`. It covers:

- Origin rules: other origins are refused, POSTs need the page's origin, and
  GETs without one (audio prefetch) still play.
- Private routes, encoded separators and dot segments never reach the app.
- Credentials and cookies are stripped in both directions.
- The hourly work ceiling is finite per client and globally. The global
  window survives a restart and refills only when the hour turns over.
- A forged `X-Forwarded-For` never buys a fresh client budget; IPv6 counts per
  `/64`; a full client table evicts idle callers instead of refusing everyone.
- `/health` and `/ready` never spend admission budget, and `/ready` fails when
  the app behind the gateway is down.

## Manual checks before a release

These need a browser and real keys. Each one spends a little provider quota.

1. **Setup.** Type a broad subject ("the moon landing"). A named series, an
   episode title and a 3–5 beat outline appear, and the hosts introduce
   themselves before any researched facts.
2. **Spoken setup.** Tap the microphone and say a subject. The transcript
   matches what you said, and the same series and episode metadata appear.
3. **Call in.** Tap **Call in** mid-segment. The hosts finish their line, say
   "caller, you're on", and only then does the red cue appear. Ask a question,
   tap **Done**, and check that the read-back line plays within a few seconds.
4. **Hang up.** Call in and hang up before speaking. The microphone closes and
   no answer plays.
5. **Library.** Open **My podcasts**, continue an episode, then play it from the
   beginning. Share it, open the link in a private window, and call in there;
   the original stays unchanged.
6. **Stub wire.** `bin/newscast --stub-wire` shows the red stub banner on the
   news preset and spends no NewsMCP budget.
7. **Playback blocked.** In a browser that blocks autoplay, the episode dock
   shows **Start listening**.

## After a deploy

- `GET /health` and `GET /ready` both return `{"ok":true}`.
- The public page loads, and starting a podcast reaches the listening room.
