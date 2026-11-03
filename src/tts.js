import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { fetchWithTimeout, readBody } from "./http.js";

const cacheDir = () => path.join(config.dataDir, "cache", "tts");

const inflight = new Map();
let active = 0;
const queue = [];
const MAX_CONCURRENT = 4;

function withSlot(fn) {
  return new Promise((resolve, reject) => {
    const run = async () => {
      active += 1;
      try {
        resolve(await fn());
      } catch (err) {
        reject(err);
      } finally {
        active -= 1;
        const next = queue.shift();
        if (next) next();
      }
    };
    if (active < MAX_CONCURRENT) run();
    else queue.push(run);
  });
}

export function voiceKey({ text, voice, instructions }) {
  return crypto
    .createHash("sha256")
    .update([config.openai.ttsModel, voice, instructions, text].join(" "))
    .digest("hex")
    .slice(0, 32);
}

/**
 * Render one line of dialogue to mp3. Cached on disk by content hash, so replaying
 * a segment, or reusing a stock line like "we have a caller", costs nothing.
 * @returns {Promise<string>} absolute path to the mp3
 */
export async function speak({ text, voice, instructions }) {
  const key = voiceKey({ text, voice, instructions });
  const file = path.join(cacheDir(), `${key}.mp3`);

  try {
    await fs.access(file);
    return file;
  } catch {
    /* not cached yet */
  }

  if (inflight.has(key)) return inflight.get(key);

  const job = withSlot(async () => {
    const res = await fetchWithTimeout(
      `${config.openai.baseUrl}/audio/speech`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.openai.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: config.openai.ttsModel,
          voice,
          input: text,
          instructions,
          response_format: "mp3",
        }),
      },
      config.timeouts.tts,
    );
    if (!res.ok) {
      const detail = await readBody(res, "text").catch(() => "");
      throw new Error(`TTS ${res.status}: ${detail.slice(0, 300)}`);
    }
    const buf = Buffer.from(await readBody(res, "arrayBuffer"));
    await fs.mkdir(cacheDir(), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, buf);
    await fs.rename(tmp, file); // atomic: a concurrent reader never sees a partial file
    return file;
  }).finally(() => inflight.delete(key));

  inflight.set(key, job);
  return job;
}

export async function cachedPath(key) {
  const file = path.join(cacheDir(), `${key}.mp3`);
  try {
    await fs.access(file);
    return file;
  } catch {
    return null;
  }
}

/** Transcribe a recorded call-in. Returns plain text. */
export async function transcribe(buffer, mimeType = "audio/webm") {
  const ext = mimeType.includes("mp4")
    ? "mp4"
    : mimeType.includes("ogg")
      ? "ogg"
      : mimeType.includes("wav")
        ? "wav"
        : "webm";
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mimeType }), `call.${ext}`);
  form.append("model", config.openai.transcribeModel);
  form.append("response_format", "json");

  const res = await fetchWithTimeout(
    `${config.openai.baseUrl}/audio/transcriptions`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${config.openai.apiKey}` },
      body: form,
    },
    config.timeouts.transcribe,
  );
  if (!res.ok) {
    const detail = await readBody(res, "text").catch(() => "");
    throw new Error(`Transcription ${res.status}: ${detail.slice(0, 300)}`);
  }
  const json = await readBody(res, "json");
  return (json.text ?? "").trim();
}
