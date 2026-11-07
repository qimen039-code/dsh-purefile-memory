import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const lib = pathToFileURL(path.resolve(import.meta.dirname, '..', 'lib')).href;
const { loadConfig } = await import(`${lib}/store.mjs`);
const { buildFtsIndex, indexFileFor } = await import(`${lib}/fts.mjs`);
const { recall } = await import(`${lib}/recall.mjs`);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-fts-filter-'));
for (const dir of ['index', 'sessions', 'projection', 'records', 'views', 'cache', 'inbox', 'system']) {
  fs.mkdirSync(path.join(root, dir), { recursive: true });
}
fs.writeFileSync(path.join(root, 'index', 'sessions.json'), JSON.stringify({ schema: 1, sessions: [] }));
fs.writeFileSync(path.join(root, 'ledger.json'), JSON.stringify({ schema: 1, entries: [] }));
const now = new Date().toISOString();
const mk = (id, title, workspace) => ({
  id, kind: 'episode', title, gist: title, key_points: [], aliases: [], tags: [], entities: [],
  workspace, project: '', scope: 'workspace', owner: 'agent', standing: 'current',
  temperature: 'warm', confidence: 0.8, created_at: now, updated_at: now, last_touched_at: now,
  review_state: 'reviewed', open_loops: [], decisions: [], relations: [], session_refs: [],
  privacy: { sensitive: false, injectable: true, redact: [] }, dir: `records/2026/10/${id}`,
});
const records = [mk('rec-target', 'alpha only', 'D:/DSH')];
for (let i = 0; i < 200; i += 1) records.push(mk(`rec-d${i}`, 'alpha beta distractor', 'D:/OTHER'));
records.push({ ...mk('rec-global', 'omega global', ''), scope: 'global' });

const catalogPath = path.join(root, 'index', 'catalog.json');
fs.writeFileSync(catalogPath, JSON.stringify({ schema: 1, counts: { records: records.length }, records }));
const cfg = loadConfig({ root, sessionsRoot: path.join(root, 'sessions'), projectionRoot: path.join(root, 'projection') });
buildFtsIndex(records, indexFileFor(cfg), { catalogPath });

const fts = recall(cfg, { query: 'alpha beta', k: 5, workspace: 'D:/DSH' });
const baseline = recall(cfg, { query: 'alpha beta', k: 5, workspace: 'D:/DSH', useIndex: false });
assert.deepEqual(fts.results.map((item) => item.id), ['rec-target']);
assert.deepEqual(baseline.results.map((item) => item.id), ['rec-target']);
const global = recall(cfg, { query: 'omega', k: 5, workspace: 'D:/DSH' });
assert.ok(global.results.some((item) => item.id === 'rec-global'));

fs.rmSync(root, { recursive: true, force: true });
console.log('fts filter smoke: ok');
