/**
 * Every outbound call in this app sits in front of a queue — the news wire is
 * concurrency-1, text-to-speech has four slots, and the call-in path is racing a
 * bridge line that is already playing. An upstream that accepts the connection and
 * then stalls would block the queue behind it, so nothing gets to use a bare fetch.
 *
 * The deadline covers **reading the body too**, not just the response headers. A
 * server that sends headers and then trickles (or never sends) the body is the
 * common stall, and a timer cleared once headers arrive does nothing about it — so
 * the abort signal here is deliberately left live until the body is consumed.
 */

function timeoutError(url, timeoutMs) {
  const err = new Error(`Request to ${hostOf(url)} timed out after ${timeoutMs}ms`);
  err.code = "TIMEOUT";
  return err;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url).slice(0, 60);
  }
}

const isAbort = (err) => err?.name === "AbortError" || err?.name === "TimeoutError";

/**
 * Fetch with a deadline that spans body consumption. Read the body through
 * `readBody` so a stall there is reported as a timeout rather than a bare abort.
 */
export async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  let res;
  try {
    res = await fetch(url, { ...options, signal });
  } catch (err) {
    if (deadline.aborted) throw timeoutError(url, timeoutMs);
    throw err;
  }
  // Carried so readBody can tell "the deadline fired" from "the caller cancelled".
  Object.defineProperty(res, Symbol.for("newscast.deadline"), {
    value: { deadline, url, timeoutMs },
    enumerable: false,
  });
  return res;
}

/** Consume a response body under the same deadline that governed the request. */
export async function readBody(res, kind = "text") {
  const meta = res[Symbol.for("newscast.deadline")];
  try {
    return await res[kind]();
  } catch (err) {
    if (meta && (meta.deadline.aborted || isAbort(err))) {
      throw timeoutError(meta.url, meta.timeoutMs);
    }
    throw err;
  }
}

/** Resolves to `fallback` if `promise` has not settled within `ms`. */
export function withDeadline(promise, ms, fallback) {
  let timer;
  return Promise.race([
    promise.catch(() => fallback),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
