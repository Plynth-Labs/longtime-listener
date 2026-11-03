#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { EpisodeStore } from "../src/episodes.js";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const snapshotFile = option("--snapshot");
const audioDir = option("--audio-dir");
const dataDir = option("--data-dir");
const explicitListener = option("--listener-id");

if (!snapshotFile || !audioDir || !dataDir) {
  console.error(
    "usage: node scripts/import-episodes.mjs --snapshot <json> --audio-dir <dir> " +
      "--data-dir <dir> [--listener-id <id>]",
  );
  process.exit(2);
}

const payload = JSON.parse(await fs.readFile(path.resolve(snapshotFile), "utf8"));
const snapshots = Array.isArray(payload?.shows) ? payload.shows : [payload];
if (explicitListener && snapshots.length !== 1) {
  throw new Error("--listener-id can only override a snapshot file containing one show");
}

const store = new EpisodeStore({ dataDir: path.resolve(dataDir) });
const imported = [];
for (const snapshot of snapshots) {
  const listenerId = explicitListener ?? snapshot.listenerId;
  if (typeof listenerId !== "string" || !/^[a-zA-Z0-9_-]{6,64}$/.test(listenerId)) {
    throw new Error("Every imported show needs a valid listenerId in the snapshot or --listener-id");
  }
  const record = await store.importLiveSnapshot(listenerId, snapshot, {
    audioDir: path.resolve(audioDir),
  });
  imported.push({
    archiveEpisodeId: record.id,
    seriesId: record.seriesId,
    episodeTitle: record.definition.episodeTitle,
    turnCount: record.state.segments.reduce((count, segment) => count + segment.turns.length, 0),
  });
}

console.log(JSON.stringify({ imported }, null, 2));

