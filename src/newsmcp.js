import crypto from "node:crypto";
import { config } from "./config.js";
import { fetchWithTimeout, readBody } from "./http.js";
import { majorSourceCount } from "./outlets.js";

// NewsMCP over Streamable HTTP. Four things this wrapper exists to enforce:
//   1. one request in flight at a time (a second concurrent call is refused 429),
//   2. a rolling hourly budget with a reserve held back for live call-ins,
//   3. a response cache — the budget is the scarce resource here, not latency,
//   4. stable story identity, because event ids are not stable (a story folded
//      into a larger one answers 404 naming its replacement).
//
// The endpoint is stateless: `tools/call` works with no `initialize` handshake and
// no session id, verified against the live service. Skipping it saves two round
// trips on every call.

function parseSse(body) {
  const messages = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload) continue;
    try {
      messages.push(JSON.parse(payload));
    } catch {
      /* keep-alive or partial frame */
    }
  }
  return messages;
}

/**
 * The provider sends zone-less local-style stamps (`2026-09-08T18:17:05`). Left to
 * `new Date`, those are read as *this machine's* local time — in Pacific that makes
 * every story look seven hours newer than it is, which quietly corrupts the
 * recency term in story ranking. They are UTC; say so.
 */
export function parseWireTime(value) {
  if (!value) return null;
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/.test(value);
  const date = new Date(hasZone ? value : `${value}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * A content-derived identity that survives the provider folding one story into
 * another and reissuing the id. Used for "already covered" bookkeeping, which is
 * stored per listener and outlives any single event id.
 */
export function storyKey(event) {
  const headline = (event.headline ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const anchor = (event.entities ?? [])
    .map((e) => (e.name ?? "").toLowerCase())
    .sort()
    .slice(0, 2)
    .join("|");
  if (!headline) return event.event_id ?? "unknown";
  return "sk_" + crypto.createHash("sha1").update(`${headline}::${anchor}`).digest("hex").slice(0, 20);
}

class Budget {
  constructor({ hourly, reserve }) {
    this.hourly = hourly;
    this.reserve = reserve;
    this.spends = []; // timestamps of metered calls we made
    this.reportedLeft = null;
    this.reportedAt = 0;
    this.resetInSeconds = null;
    this.blockedUntil = 0;
  }

  #prune() {
    const cutoff = Date.now() - 60 * 60 * 1000;
    this.spends = this.spends.filter((t) => t > cutoff);
  }

  reportIsFresh() {
    return this.reportedLeft !== null && Date.now() - this.reportedAt < 60 * 1000;
  }

  remaining() {
    this.#prune();
    const own = Math.max(0, this.hourly - this.spends.length);
    // The reported figure includes calls other keyless clients on this address
    // made, so it is authoritative while fresh.
    if (this.reportIsFresh()) return Math.min(own, Math.max(0, this.reportedLeft));
    return own;
  }

  allows(priority) {
    if (Date.now() < this.blockedUntil) return false;
    // `essential` work — the headline pull a show cannot start without, and live
    // call-ins — may spend down to zero. `background` work (topping up a pool that
    // already has stories in it) stops at the reserve so it can never starve them.
    const floor = priority === "essential" ? 0 : this.reserve;
    return this.remaining() > floor;
  }

  spend() {
    this.spends.push(Date.now());
    if (this.reportedLeft !== null) this.reportedLeft -= 1;
  }

  report({ left, limit, resetIn }) {
    if (typeof left === "number") this.reportedLeft = left;
    if (typeof limit === "number" && limit > 0) this.hourly = limit;
    if (typeof resetIn === "number") this.resetInSeconds = resetIn;
    this.reportedAt = Date.now();
  }

  block(seconds) {
    this.blockedUntil = Date.now() + Math.max(1, seconds) * 1000;
  }

  status() {
    return {
      remaining: this.remaining(),
      hourly: this.hourly,
      reserve: this.reserve,
      reported: this.reportIsFresh(),
      // Metered calls this process made in the last hour. A gap against
      // `remaining` means other keyless clients on this address are spending too.
      spentByUs: this.spends.length,
      resetInSeconds: this.resetInSeconds,
      blockedForSeconds: Math.max(0, Math.ceil((this.blockedUntil - Date.now()) / 1000)),
    };
  }
}

export class NewsMcp {
  constructor(options = {}) {
    this.url = options.url ?? config.newsmcp.url;
    this.apiKey = options.apiKey ?? config.newsmcp.apiKey;
    this.budget = new Budget({
      hourly: options.hourlyBudget ?? config.newsmcp.hourlyBudget,
      reserve: options.callInReserve ?? config.newsmcp.callInReserve,
    });
    this.limits = null;
    this.chain = Promise.resolve(); // serialises every request: concurrency 1
    this.cache = new Map();
    this.notes = [];
  }

  #headers() {
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (this.apiKey) headers["x-api-key"] = this.apiKey;
    return headers;
  }

  async #callTool(name, args) {
    const res = await fetchWithTimeout(
      this.url,
      {
        method: "POST",
        headers: this.#headers(),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Math.floor(Math.random() * 1e6),
          method: "tools/call",
          params: { name, arguments: args },
        }),
      },
      config.timeouts.newsmcp,
    );
    const body = await readBody(res, "text");
    if (!res.ok) {
      const err = new Error(`NewsMCP HTTP ${res.status}: ${body.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    const message = parseSse(body)[0];
    if (!message) throw new Error("NewsMCP returned no JSON-RPC message");
    if (message.error) {
      const err = new Error(`NewsMCP error ${message.error.code}: ${message.error.message}`);
      err.rpc = message.error;
      throw err;
    }
    const text = message.result?.content?.[0]?.text ?? "";
    if (message.result?.isError) throw new Error(`NewsMCP tool error: ${text.slice(0, 300)}`);
    return text;
  }

  /** Every outbound request goes through here, one at a time. */
  #serialize(fn) {
    const next = this.chain.then(fn, fn);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** Free — exempt from metering, so it never spends a call, a slot, or a credit. */
  async checkLimits() {
    const text = await this.#serialize(() => this.#callTool("check_limits", { response_format: "json" }));
    try {
      const parsed = JSON.parse(text.slice(text.indexOf("{")));
      this.limits = {
        plan: parsed.plan,
        maxConcurrent: parsed.max_concurrent,
        lookbackDays: parsed.lookback_days,
        maxEvents: parsed.max_events,
      };
      this.budget.report({
        left: parsed.calls_per_hour?.left,
        limit: parsed.calls_per_hour?.limit,
        resetIn: parsed.calls_per_hour?.reset_in,
      });
      if (parsed.retry_after > 0) this.budget.block(parsed.retry_after);
    } catch {
      // Older shape: "searches left this hour: 19 of 20".
      const left = /searches left this hour:\s*(\d+)\s*of\s*(\d+)/i.exec(text);
      if (left) this.budget.report({ left: Number(left[1]), limit: Number(left[2]) });
    }
    return { ...this.budget.status(), limits: this.limits };
  }

  status() {
    return { ...this.budget.status(), limits: this.limits, notes: this.notes.slice(-5) };
  }

  #cached(key, ttlMs) {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return { ...hit.value, cached: true };
    return null;
  }

  /**
   * Fetch synthesized story events.
   * @param {object} args  news() tool arguments
   * @param {object} opts  { priority: 'essential'|'background', ttlMs, cacheKey }
   */
  async news(args = {}, opts = {}) {
    const priority = opts.priority ?? "background";
    const ttlMs = opts.ttlMs ?? config.newsmcp.searchTtlMs;
    const key = opts.cacheKey ?? `news:${JSON.stringify(args)}`;

    const early = this.#cached(key, ttlMs);
    if (early) return early;

    return this.#serialize(async () => {
      // Re-check inside the slot. Two callers can both miss the cache and both pass
      // the budget check while a third request is in flight; whichever queued first
      // fills the cache and refreshes the budget, and everyone behind it must see
      // that rather than spending a second call or slipping under the reserve.
      const cached = this.#cached(key, ttlMs);
      if (cached) return cached;

      if (!this.budget.reportIsFresh()) {
        // Free, and it tells us what other clients on this address have spent.
        await this.checkLimitsUnserialized().catch(() => {});
      }

      if (!this.budget.allows(priority)) {
        const stale = this.cache.get(key);
        if (stale) return { ...stale.value, cached: true, stale: true };
        const status = this.budget.status();
        const wait = status.blockedForSeconds || status.resetInSeconds;
        const err = new Error(
          wait
            ? `The news wire is out of calls for this hour. It refills in about ${Math.ceil(wait / 60)} minutes.`
            : `The news wire is out of calls for this hour (${status.hourly} per hour, shared across everyone on this network).`,
        );
        err.code = "BUDGET_EXHAUSTED";
        err.retryAfterSeconds = wait ?? null;
        throw err;
      }

      this.budget.spend();
      console.log(
        `[newsmcp] call ${this.budget.spends.length} (${this.budget.remaining()} left) ` +
          `priority=${priority} ${JSON.stringify(args)}`,
      );
      let text;
      try {
        text = await this.#callTool("news", {
          limit: config.newsmcp.storyLimit,
          verbosity: "standard",
          response_format: "json",
          ...args,
        });
      } catch (err) {
        const retryAfter = /retry[_ ]after[_ ]?seconds["\s:]*(\d+)/i.exec(err.message);
        if (/429/.test(err.message) && retryAfter) this.budget.block(Number(retryAfter[1]));
        throw err;
      }

      const value = this.#parseNews(text);
      this.cache.set(key, { at: Date.now(), value });
      return value;
    });
  }

  /** checkLimits without taking the slot — for use from inside the slot. */
  async checkLimitsUnserialized() {
    const text = await this.#callTool("check_limits", { response_format: "json" });
    try {
      const parsed = JSON.parse(text.slice(text.indexOf("{")));
      this.budget.report({
        left: parsed.calls_per_hour?.left,
        limit: parsed.calls_per_hour?.limit,
        resetIn: parsed.calls_per_hour?.reset_in,
      });
      if (parsed.retry_after > 0) this.budget.block(parsed.retry_after);
    } catch {
      /* leave the local tally in charge */
    }
  }

  #parseNews(text) {
    const start = text.indexOf("{");
    if (start === -1) return { events: [], notes: [], raw: text };
    let parsed;
    try {
      parsed = JSON.parse(text.slice(start));
    } catch {
      return { events: [], notes: [], raw: text };
    }

    // Keyless callers get told when a request was narrowed to fit the allowance.
    // Relay it rather than presenting a narrowed result as complete.
    const notes = [];
    for (const field of ["note", "notes", "notice", "notices", "warnings"]) {
      const value = parsed[field];
      if (typeof value === "string") notes.push(value);
      else if (Array.isArray(value)) notes.push(...value.filter((v) => typeof v === "string"));
    }
    const applied = parsed.applied_filters ?? null;
    if (applied && typeof applied === "object") {
      for (const [k, v] of Object.entries(applied)) {
        if (v && typeof v === "object" && "requested" in v && "applied" in v && v.requested !== v.applied) {
          notes.push(`${k} narrowed from ${v.requested} to ${v.applied}`);
        }
      }
    }
    for (const n of notes) if (!this.notes.includes(n)) this.notes.push(n);

    return {
      events: (parsed.events ?? []).map(normaliseEvent),
      total: parsed.total,
      appliedFilters: applied,
      notes,
    };
  }
}

function normaliseEvent(e) {
  const firstSeen = parseWireTime(e.first_seen);
  const lastSeen = parseWireTime(e.last_seen);
  return {
    id: e.event_id,
    key: storyKey(e), // stable across the provider re-issuing event ids
    headline: e.headline,
    abstract: e.abstract,
    sector: e.sector,
    eventType: e.event_type,
    contentType: e.content_type,
    entities: (e.entities ?? []).map((x) => ({ name: x.name, salience: x.salience })),
    sources: (e.sources ?? []).slice(0, 4),
    newsrooms: e.newsrooms ?? 0,
    reports: e.reports ?? 0,
    confidence: e.confidence ?? 0,
    firstSeen: firstSeen ? firstSeen.toISOString() : null,
    lastSeen: lastSeen ? lastSeen.toISOString() : null,
  };
}

/**
 * Screen wire stories down to the ones a general audience would call news: carried
 * by at least one national outlet, and picked up by enough newsrooms to be more
 * than a local item.
 *
 * This is the only place a corroboration count is used and it never leaves this
 * function — "forty newsrooms carried it" screens a story on the way in; it is not
 * a fact about the world and the hosts never say it.
 *
 * Every consumer of wire events goes through here. A caller asking about a named
 * subject gets the same floor as the episode planner, or the screening would be
 * one search away from being bypassed entirely.
 */
export function screenStories(events, { maxAgeHours = null, limit = null } = {}) {
  const cutoff = maxAgeHours ? Date.now() - maxAgeHours * 3600000 : null;
  const kept = events.filter((e) => {
    if (majorSourceCount(e) < config.newsmcp.minMajorSources) return false;
    if ((e.newsrooms ?? 0) < config.newsmcp.minNewsrooms) return false;
    if (!cutoff) return true;
    const seen = new Date(e.lastSeen || e.firstSeen || 0).getTime();
    return Number.isFinite(seen) && seen >= cutoff;
  });
  kept.sort(
    (a, b) =>
      new Date(b.lastSeen || b.firstSeen || 0).getTime() -
      new Date(a.lastSeen || a.firstSeen || 0).getTime(),
  );
  return limit ? kept.slice(0, limit) : kept;
}

export const newsmcp = new NewsMcp();
