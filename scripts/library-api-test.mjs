// Exercise the real HTTP surface with a restart and two independent listeners.
// No provider credentials or network access are required.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'listener-api-'));
Object.assign(process.env, {
  NEWSCAST_DATA_DIR: dataDir, ANTHROPIC_API_KEY: 'test', OPENAI_API_KEY: 'test',
  OPENAI_BASE_URL: 'http://127.0.0.1:1/v1', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
  NEWSMCP_URL: 'http://127.0.0.1:1/mcp', WIKIPEDIA_API_URL: 'http://127.0.0.1:1/w/api.php',
});
const { EpisodeStore } = await import('../src/episodes.js');
const { defineShow } = await import('../src/showdef.js');
const store = new EpisodeStore({ dataDir });
const owner = 'l_library_owner_fixture', guest = 'l_library_guest_fixture';
const definition = defineShow({ about: 'Computing history', angle: 'The early machines', episodes: 'One machine per episode' });
const audioDir = path.join(dataDir, 'fixture-audio');
await fs.mkdir(audioDir);
const audioKey = 'a'.repeat(32);
const audio = Buffer.from('original archive audio bytes');
await fs.writeFile(path.join(audioDir, audioKey + '.mp3'), audio);
const snapshot = {
  def: definition,
  segments: [{ id: 'seg_fixture_intro', kind: 'story', title: 'The first machine', complete: true,
    aired: true, airedThrough: 0, sources: [], coverKeys: [], createdAt: Date.now(),
    turns: [{ speaker: 'ari', text: 'Welcome to our episode.', audioKey },
      { speaker: 'dev', text: 'We will explore early computers.', audioKey }],
  }],
  deliveredThrough: 0, onAir: { segmentId: 'seg_fixture_intro', turnIndex: 0 },
  heardTurnKeys: ['seg_fixture_intro:0'], heardSeconds: 5,
};
const imported = await store.importLiveSnapshot(owner, snapshot, { audioDir });
assert.ok(imported.id);
const repeated = await store.importLiveSnapshot(owner, snapshot, { audioDir });
assert.equal(repeated.id, imported.id, 'migration must be idempotent');

const socket = http.createServer();
socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
let child, logs = '';
async function start() {
  child = spawn(process.execPath, ['server.js'], { cwd: root,
    env: { ...process.env, PORT: String(port), BASE_PATH: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', data => { logs += data; });
  child.stderr.on('data', data => { logs += data; });
  for (let i = 0; i < 100; i++) {
    if (child.exitCode != null) throw new Error('API exited: ' + logs);
    try { const response = await fetch(`http://127.0.0.1:${port}/api/status`); if (response.ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('API did not start: ' + logs);
}
async function stop() {
  if (!child || child.exitCode != null) return;
  const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
}
async function request(route, listener = owner, body, expected = 200) {
  const response = await fetch(`http://127.0.0.1:${port}/api/${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(listener ? { 'x-listener-id': listener } : {}), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, expected, `${route}: ${text}`);
  return text ? JSON.parse(text) : null;
}

try {
  await start();
  await request('replay/next?wait=0', guest, undefined, 409);
  const library = await request('episodes');
  assert.equal(library.podcasts.length, 1);
  assert.equal(library.podcasts[0].episodes[0].id, imported.id);
  assert.deepEqual((await request('episodes', guest)).podcasts, []);
  await request(`episodes/${imported.id}/open`, guest, { from: 'start' }, 404);
  await request(`episodes/${imported.id}/share`, guest, {}, 404);
  const studioCount = (await request('status', null)).shows;
  for (let index = 0; index < 3; index++) {
    await request(`episodes/${imported.id}/share`, `l_invalid_share_${index}`, {}, 404);
  }
  assert.equal((await request('status', null)).shows, studioCount, 'invalid shares must not allocate studio sessions');
  const original = await store.load(owner, imported.id);
  const share = await request(`episodes/${imported.id}/share`, owner, {});
  const again = await request(`episodes/${imported.id}/share`, owner, {});
  assert.equal(again.shareId, share.shareId);
  assert.ok(share.shareId.length >= 32, 'share token needs at least 128 bits of entropy');
  const preview = await request(`shared/${share.shareId}`, null);
  assert.ok(!JSON.stringify(preview).includes(owner), 'public preview leaked owner credential');
  const opened = await request(`shared/${share.shareId}/open`, guest, {});
  assert.equal(opened.listenerId, guest);
  assert.equal(opened.playback.from, 'start');
  assert.equal(opened.playback.shared, true);
  const first = await request('replay/next?wait=0', guest);
  assert.equal(first.resumeFrom, 0);
  assert.equal(first.turns[0].text, snapshot.segments[0].turns[0].text);
  const audioResponse = await fetch(`http://127.0.0.1:${port}/api/audio/${first.id}/0`, { headers: { 'x-listener-id': guest } });
  assert.equal(audioResponse.status, 200);
  assert.deepEqual(Buffer.from(await audioResponse.arrayBuffer()), audio, 'replay must return original audio bytes');
  await request('progress', guest, { segmentId: first.id, turnIndex: 0, phase: 'finished', heardSeconds: 8 });
  await request('progress', guest, { segmentId: first.id, turnIndex: 1, phase: 'finished', heardSeconds: 8 });
  const ended = await request('next?wait=0', guest);
  assert.equal(ended.episodeEnded, true);
  const afterGuest = await store.load(owner, imported.id);
  assert.deepEqual(afterGuest.state, original.state, 'guest playback changed original episode');
  await stop(); await start();
  assert.equal((await request('episodes')).podcasts[0].episodes[0].id, imported.id);
  const anonymous = await request(`shared/${share.shareId}/open`, null, {});
  assert.ok(anonymous.listenerId && anonymous.listenerId !== owner && anonymous.listenerId !== guest);
  assert.equal((await request('next?wait=0', anonymous.listenerId)).resumeFrom, 0);
  await request(`episodes/${imported.id}/open`, owner, { from: 'resume' });
  assert.equal((await request('next?wait=0')).resumeFrom, 1, 'owner resume lost its saved place');
  await request(`episodes/${imported.id}/open`, owner, { from: 'start' });
  assert.equal((await request('next?wait=0')).resumeFrom, 0);
  await request('show/reset', owner, {});
  await request(`episodes/${imported.id}/open`, owner, { from: 'start' });
  assert.equal((await request('next?wait=0')).turns[0].text, snapshot.segments[0].turns[0].text,
    'leaving a replay cancelled the saved original');
  const changed = await store.load(owner, imported.id);
  changed.definition.episodeTitle = 'A later private revision';
  changed.state.segments[0].turns[0].text = 'This was added after the share.';
  await store.save(owner, changed);
  const frozen = await request(`shared/${share.shareId}`, null);
  assert.equal(frozen.episode.episodeTitle, preview.episode.episodeTitle);
  const newGuest = await request(`shared/${share.shareId}/open`, null, {});
  assert.equal((await request('next?wait=0', newGuest.listenerId)).turns[0].text, snapshot.segments[0].turns[0].text,
    'sharing must freeze the version that the owner chose to share');
  console.log('Library API: ownership, grouping, share isolation, exact audio, EOF and restart checks passed.');
} catch (error) {
  console.error(logs.slice(-5000));
  throw error;
} finally {
  await stop();
  await fs.rm(dataDir, { recursive: true, force: true });
}
