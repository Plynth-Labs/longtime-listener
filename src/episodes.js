import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

const ARCHIVE_SCHEMA = 1;
const MAX_EPISODES_PER_LISTENER = 1000;
const ID = /^[a-zA-Z0-9_-]{6,80}$/;
const AUDIO_KEY = /^[a-f0-9]{32}$/;

const clone = (value) => JSON.parse(JSON.stringify(value));
const ownerKey = (listenerId) => crypto.createHash("sha256").update(listenerId).digest("hex");
const freshId = (prefix, bytes = 10) => `${prefix}_${crypto.randomBytes(bytes).toString("hex")}`;
const iso = (value = Date.now()) => new Date(value).toISOString();

function playableTurns(segment = {}) {
  if (segment.cancelled) return [];
  const turns = segment.turns ?? [];
  return segment.abandoned
    ? turns.slice(0, Math.max(0, Math.min(turns.length, Number(segment.airedThrough) + 1)))
    : turns;
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await fs.rename(tmp, file);
}

function publicMetadata(record) {
  const definition = record.definition ?? {};
  const playback = record.playback ?? record.state ?? {};
  return {
    id: record.id,
    seriesId: record.seriesId ?? definition.seriesId,
    episodeTitle: definition.episodeTitle,
    episodeBrief: definition.episodeBrief,
    episodeNumber: definition.episodeNumber ?? 1,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    parentEpisodeId: record.parentEpisodeId ?? null,
    parentEpisodeTitle: record.parentEpisodeTitle ?? null,
    isBranch: !!record.isBranch,
    turnCount: (record.state?.segments ?? []).reduce((n, segment) => n + playableTurns(segment).length, 0),
    heardTurnCount: playback.heardTurnKeys?.length ?? 0,
    heardSeconds: Number(playback.heardSeconds) || 0,
    shareId: record.shareId ?? null,
  };
}

function playbackFromState(state = {}) {
  return {
    segments: (state.segments ?? []).map((segment) => ({
      id: segment.id,
      aired: !!segment.aired,
      airedThrough: Number(segment.airedThrough ?? -1),
    })),
    deliveredThrough: Number(state.deliveredThrough ?? -1),
    onAir: state.onAir ?? null,
    covered: state.covered ?? [],
    heardTurns: state.heardTurns ?? [],
    heardTurnKeys: state.heardTurnKeys ?? [],
    heardDurations: state.heardDurations ?? {},
    heardSeconds: Number(state.heardSeconds ?? 0),
    direction: state.direction ?? null,
    lastCallReminderAtSeconds: state.lastCallReminderAtSeconds ?? null,
    hasCalled: !!state.hasCalled,
  };
}

export class EpisodeStore {
  constructor({ dataDir = config.dataDir, maxEpisodes = MAX_EPISODES_PER_LISTENER } = {}) {
    this.dataDir = dataDir;
    this.maxEpisodes = maxEpisodes;
    this.writes = new Map();
  }

  #ownersDir() {
    return path.join(this.dataDir, "episodes", "owners");
  }

  #ownerDir(listenerId) {
    return path.join(this.#ownersDir(), ownerKey(listenerId));
  }

  #episodeFile(listenerId, episodeId) {
    if (!ID.test(episodeId)) return null;
    return path.join(this.#ownerDir(listenerId), `${episodeId}.json`);
  }

  #shareFile(shareId) {
    if (!ID.test(shareId)) return null;
    return path.join(this.dataDir, "episodes", "shares", `${shareId}.json`);
  }

  #serialize(key, operation) {
    const prior = this.writes.get(key) ?? Promise.resolve();
    const job = prior.catch(() => {}).then(operation);
    this.writes.set(key, job);
    return job.finally(() => {
      if (this.writes.get(key) === job) this.writes.delete(key);
    });
  }

  async list(listenerId) {
    let names;
    try {
      names = await fs.readdir(this.#ownerDir(listenerId));
    } catch (err) {
      if (err.code === "ENOENT") return [];
      throw err;
    }
    const records = await Promise.all(
      names.filter((name) => ID.test(name.replace(/\.json$/, "")) && name.endsWith(".json"))
        .map((name) => readJson(path.join(this.#ownerDir(listenerId), name))),
    );
    return records.filter((record) => record?.schema === ARCHIVE_SCHEMA);
  }

  async podcasts(listenerId) {
    const records = await this.list(listenerId);
    const groups = new Map();
    for (const record of records) {
      const def = record.definition ?? {};
      const seriesId = record.seriesId ?? def.seriesId;
      if (!seriesId) continue;
      let group = groups.get(seriesId);
      if (!group) {
        group = {
          seriesId,
          title: def.title,
          brief: def.brief,
          about: def.about,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          episodes: [],
        };
        groups.set(seriesId, group);
      }
      group.createdAt = group.createdAt < record.createdAt ? group.createdAt : record.createdAt;
      if (group.updatedAt < record.updatedAt) group.updatedAt = record.updatedAt;
      group.episodes.push(publicMetadata(record));
    }
    for (const group of groups.values()) {
      group.episodes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }
    return [...groups.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async load(listenerId, episodeId) {
    const file = this.#episodeFile(listenerId, episodeId);
    if (!file) return null;
    const record = await readJson(file);
    return record?.schema === ARCHIVE_SCHEMA ? record : null;
  }

  async findByDefinitionEpisodeId(listenerId, definitionEpisodeId) {
    if (!definitionEpisodeId) return null;
    const matches = (await this.list(listenerId))
      .filter((record) => record.definition?.episodeId === definitionEpisodeId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return matches[0] ?? null;
  }

  async save(listenerId, snapshot) {
    const id = ID.test(snapshot?.id ?? "") ? snapshot.id : freshId("ep");
    const key = `${ownerKey(listenerId)}:${id}`;
    return this.#serialize(key, async () => {
      const file = this.#episodeFile(listenerId, id);
      const existing = await readJson(file);
      if (!existing) {
        const count = (await this.list(listenerId)).length;
        if (count >= this.maxEpisodes) {
          const err = new Error("This podcast library has reached its episode limit.");
          err.status = 507;
          err.code = "EPISODE_LIMIT";
          throw err;
        }
      }
      const now = iso();
      const record = clone({
        ...snapshot,
        schema: ARCHIVE_SCHEMA,
        id,
        seriesId: snapshot.seriesId ?? snapshot.definition?.seriesId,
        createdAt: existing?.createdAt ?? snapshot.createdAt ?? now,
        updatedAt: now,
        shareId: existing?.shareId ?? snapshot.shareId ?? null,
        playback: snapshot.playback ?? playbackFromState(snapshot.state),
      });
      await atomicJson(file, record);
      return record;
    });
  }

  async savePlayback(listenerId, episodeId, playback) {
    const file = this.#episodeFile(listenerId, episodeId);
    if (!file) return null;
    const key = `${ownerKey(listenerId)}:${episodeId}`;
    return this.#serialize(key, async () => {
      const record = await readJson(file);
      if (!record) {
        const err = new Error("The saved episode disappeared while playback was being recorded.");
        err.status = 409;
        err.code = "EPISODE_NOT_FOUND";
        throw err;
      }
      record.playback = clone(playback);
      record.updatedAt = iso();
      await atomicJson(file, record);
      return record;
    });
  }

  async remove(listenerId, episodeId) {
    const file = this.#episodeFile(listenerId, episodeId);
    if (!file) return false;
    const key = `${ownerKey(listenerId)}:${episodeId}`;
    return this.#serialize(key, async () => {
      try {
        await fs.unlink(file);
        return true;
      } catch (err) {
        if (err.code === "ENOENT") return false;
        throw err;
      }
    });
  }

  async share(listenerId, episodeId) {
    if (!ID.test(episodeId)) return null;
    const key = `${ownerKey(listenerId)}:${episodeId}`;
    return this.#serialize(key, async () => {
      // Load only after earlier streamed saves have landed. Patching the latest
      // record prevents share creation from writing an older script back over it.
      const file = this.#episodeFile(listenerId, episodeId);
      const record = await readJson(file);
      if (!record) return null;
      if (record.shareId) {
        const existing = await this.loadShared(record.shareId);
        if (existing) return { shareId: record.shareId, record: existing.episode };
      }
      const shareId = freshId("share", 18);
      const episode = clone({ ...record, shareId: null });
      episode.definition.episodeHistory = [];
      episode.state.plan = [];
      episode.state.direction = null;
      episode.state.segments = episode.state.segments.map((segment) => ({
        ...segment,
        why: "",
        planItem: null,
        coverKeys: [],
      }));
      episode.state.heardTurns = [];
      episode.state.heardTurnKeys = [];
      episode.state.heardSeconds = 0;
      episode.state.heardDurations = {};
      episode.state.covered = [];
      episode.state.onAir = null;
      episode.state.deliveredThrough = -1;
      episode.state.lastCallReminderAtSeconds = null;
      episode.state.hasCalled = false;
      episode.playback = playbackFromState({
        segments: episode.state.segments.map((segment) => ({
          id: segment.id,
          aired: false,
          airedThrough: -1,
        })),
      });
      const frozen = { schema: ARCHIVE_SCHEMA, shareId, createdAt: iso(), episode };
      await atomicJson(this.#shareFile(shareId), frozen);
      record.shareId = shareId;
      record.updatedAt = iso();
      await atomicJson(file, record);
      return { shareId, record: frozen.episode };
    });
  }

  async loadShared(shareId) {
    const file = this.#shareFile(shareId);
    if (!file) return null;
    const shared = await readJson(file);
    return shared?.schema === ARCHIVE_SCHEMA && shared?.episode ? shared : null;
  }

  async assertPlayable(record) {
    const keys = [...new Set(
      (record?.state?.segments ?? [])
        .flatMap((segment) => playableTurns(segment).map((turn) => turn.audio)),
    )];
    const missing = [];
    for (const key of keys) {
      if (!AUDIO_KEY.test(key ?? "")) {
        missing.push(key ?? "(missing key)");
        continue;
      }
      try {
        await fs.access(path.join(this.dataDir, "cache", "tts", `${key}.mp3`));
      } catch {
        missing.push(key);
      }
    }
    if (missing.length) {
      const err = new Error("This saved episode is still waiting for original audio.");
      err.status = 409;
      err.code = "ARCHIVE_AUDIO_PENDING";
      err.missingAudio = missing;
      throw err;
    }
    return true;
  }

  metadata(record) {
    return publicMetadata(record);
  }

  /**
   * Import a read-only snapshot captured from a pre-library server. The complete
   * audio set is verified and copied before its archive record becomes visible.
   */
  async importLiveSnapshot(listenerId, snapshot, { audioDir } = {}) {
    const source = snapshot?.def ? snapshot : snapshot?.show ?? snapshot;
    const definition = source?.def ?? source?.definition;
    if (!definition?.episodeId || !Array.isArray(source?.segments)) {
      const err = new Error("The live snapshot does not contain an episode definition and segments.");
      err.code = "INVALID_LIVE_SNAPSHOT";
      throw err;
    }
    const segments = source.segments.map((item) => {
      const view = item.view ?? item;
      return {
        ...view,
        planItem: item.planItem ?? view.planItem ?? null,
        coverKeys: item.coverKeys ?? view.coverKeys ?? [],
        aired: item.aired ?? view.aired ?? false,
        airedThrough: item.airedThrough ?? view.airedThrough ?? -1,
        createdAt: item.createdAt ?? view.createdAt ?? Date.now(),
        turns: (view.turns ?? []).map((turn) => ({ ...turn, audio: turn.audio ?? turn.audioKey })),
      };
    });
    const keys = [...new Set(segments.flatMap((segment) => segment.turns.map((turn) => turn.audio)))];
    if (!audioDir || keys.some((key) => !AUDIO_KEY.test(key ?? ""))) {
      const err = new Error("The live snapshot is missing validated audio keys or an audio directory.");
      err.code = "INVALID_LIVE_AUDIO";
      throw err;
    }
    const sources = keys.map((key) => path.join(audioDir, `${key}.mp3`));
    const missingSources = [];
    await Promise.all(sources.map(async (file, index) => {
      try {
        await fs.access(file);
      } catch {
        missingSources.push(keys[index]);
      }
    }));
    if (missingSources.length) {
      const err = new Error(`The live snapshot is missing ${missingSources.length} original audio file(s).`);
      err.code = "MISSING_LIVE_AUDIO";
      err.missingAudio = missingSources;
      throw err;
    }

    const prior = (await this.list(listenerId)).find(
      (record) => record.importedFrom?.definitionEpisodeId === definition.episodeId,
    );
    const record = {
      id: prior?.id,
      seriesId: definition.seriesId,
      definition,
      importedFrom: { schema: snapshot?.schema ?? 1, definitionEpisodeId: definition.episodeId },
      state: {
        segments,
        plan: source.plan ?? [],
        covered: source.covered ?? [],
        seeds: source.seeds ?? [],
        seedsAt: source.seedsAt ?? 0,
        onAir: source.onAir ?? null,
        deliveredThrough: source.deliveredThrough ?? -1,
        heardTurns: source.heardTurns ?? [],
        heardTurnKeys: source.heardTurnKeys ?? [],
        heardSeconds: source.heardSeconds ?? 0,
        direction: source.direction ?? null,
        lastCallReminderAtSeconds: source.lastCallReminderAtSeconds ?? null,
        hasCalled: source.hasCalled ?? false,
      },
    };

    const targetDir = path.join(this.dataDir, "cache", "tts");
    await fs.mkdir(targetDir, { recursive: true });
    for (let i = 0; i < keys.length; i += 1) {
      const target = path.join(targetDir, `${keys[i]}.mp3`);
      try {
        await fs.access(target);
      } catch {
        const tmp = `${target}.${process.pid}.tmp`;
        await fs.copyFile(sources[i], tmp);
        await fs.rename(tmp, target);
      }
    }
    return this.save(listenerId, record);
  }
}

export const episodes = new EpisodeStore();
