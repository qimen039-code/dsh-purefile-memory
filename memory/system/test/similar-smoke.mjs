import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const lib = pathToFileURL(path.resolve(import.meta.dirname, '..', 'lib')).href;
const { loadConfig } = await import(`${lib}/store.mjs`);
const { buildFtsIndex, indexFileFor } = await import(`${lib}/fts.mjs`);
const { similarRecords } = await import(`${lib}/related.mjs`);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-similar-test-'));
for (const dir of ['index', 'sessions', 'projection', 'records', 'views', 'cache', 'inbox', 'system']) {
  fs.mkdirSync(path.join(root, dir), { recursive: true });
}
fs.writeFileSync(path.join(root, 'index', 'sessions.json'), JSON.stringify({ schema: 1, sessions: [] }));
fs.writeFileSync(path.join(root, 'ledger.json'), JSON.stringify({ schema: 1, entries: [] }));
const now = new Date().toISOString();
const mk = (id, title, gist, tags) => ({
  id, kind: 'episode', title, gist, key_points: [], aliases: [], tags,
  entities: [], workspace: 'D:/DSH', project: 'test', scope: 'workspace', owner: 'agent',
  standing: 'current', temperature: 'warm', confidence: 0.8,
  created_at: now, updated_at: now, last_touched_at: now,
  review_state: 'reviewed', open_loops: [], decisions: [], relations: [],
  session_refs: [], privacy: { sensitive: false, injectable: true, redact: [] },
  dir: `records/2026/10/${id}`,
});
const records = [
  mk('rec-20261026-000000-0001', 'Orion 缓存一致性 设计', 'Orion 缓存一致性方案', ['orion', 'cache']),
  mk('rec-20261026-000000-0002', 'Orion 缓存一致性 旧方案', 'Orion 缓存旧方案与回源', ['orion', 'cache']),
  mk('rec-20261026-000000-0003', 'Lumen 分页游标 设计', 'Lumen 分页游标方案', ['lumen', 'page']),
];
const catalogPath = path.join(root, 'index', 'catalog.json');
fs.writeFileSync(catalogPath, JSON.stringify({ schema: 1, counts: { records: 3 }, records }));
const cfg = loadConfig({ root, sessionsRoot: path.join(root, 'sessions'), projectionRoot: path.join(root, 'projection') });
buildFtsIndex(records, indexFileFor(cfg), { catalogPath });

const result = similarRecords(cfg, { title: 'Orion 缓存一致性 新方案', k: 3 });
assert.equal(result.available, true);
assert.equal(result.results[0].id, records[0].id);
assert.ok(result.results.every((item) => item.id !== records[2].id));
assert.equal(similarRecords(cfg, { query: 'Orion 缓存', excludeId: records[0].id }).results[0].id, records[1].id);

fs.rmSync(root, { recursive: true, force: true });
console.log('similar smoke: ok');
