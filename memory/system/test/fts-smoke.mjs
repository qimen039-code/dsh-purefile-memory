import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const lib = pathToFileURL(path.resolve(import.meta.dirname, '..', 'lib')).href;
const { loadConfig } = await import(`${lib}/store.mjs`);const { recall } = await import(`${lib}/recall.mjs`);
const { buildFtsIndex, indexFileFor, isIndexFresh, searchFts, refreshFtsRecord, searchCacheStats } = await import(`${lib}/fts.mjs`);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-fts-test-'));
const dirs = ['index', 'sessions', 'projection', 'records', 'views', 'cache', 'inbox', 'system'];
for (const dir of dirs) fs.mkdirSync(path.join(root, dir), { recursive: true });
fs.writeFileSync(path.join(root, 'index', 'sessions.json'), JSON.stringify({ schema: 1, sessions: [] }));
fs.writeFileSync(path.join(root, 'ledger.json'), JSON.stringify({ schema: 1, entries: [] }));

const now = new Date().toISOString();
const records = [
  {
    id: 'rec-20261026-000000-0001', kind: 'project', title: 'Orion 缓存一致性 设计',
    gist: 'Orion 缓存一致性方案，编号 CACHE-7，包含失效与回源。',
    key_points: ['缓存失效', '回源策略'], aliases: ['Orion 缓存旧称'],
    tags: ['orion', 'cache'], entities: ['Orion'],
    workspace: 'D:/DSH', project: 'Orion', scope: 'workspace', owner: 'agent',
    standing: 'current', temperature: 'hot', confidence: 0.9,
    created_at: now, updated_at: now, last_touched_at: now,
    review_state: 'reviewed', open_loops: [], decisions: [], relations: [],
    session_refs: [], privacy: { sensitive: false, injectable: true, redact: [] },
    dir: 'records/2026/10/rec-20261026-000000-0001',
  },
  {
    id: 'rec-20261026-000000-0002', kind: 'episode', title: 'Lumen 分页游标 记录',
    gist: 'Lumen 分页游标方案，编号 PAGE-8。',
    key_points: ['游标分页'], aliases: ['Lumen 分页旧称'],
    tags: ['lumen', 'page'], entities: ['Lumen'],
    workspace: 'D:/DSH', project: 'Lumen', scope: 'workspace', owner: 'agent',
    standing: 'current', temperature: 'warm', confidence: 0.8,
    created_at: now, updated_at: now, last_touched_at: now,
    review_state: 'reviewed', open_loops: [], decisions: [], relations: [],
    session_refs: [], privacy: { sensitive: false, injectable: true, redact: [] },
    dir: 'records/2026/10/rec-20261026-000000-0002',
  },
];
const catalogPath = path.join(root, 'index', 'catalog.json');
fs.writeFileSync(catalogPath, JSON.stringify({ schema: 1, generated_at: now, counts: { records: records.length }, records }));
const cfg = loadConfig({ root, sessionsRoot: path.join(root, 'sessions'), projectionRoot: path.join(root, 'projection') });
const dbPath = indexFileFor(cfg);
const built = buildFtsIndex(records, dbPath, { catalogPath });
assert.equal(built.records, 2);
assert.equal(isIndexFresh(cfg), true);

const hit = searchFts(dbPath, '缓存一致性', { limit: 10 });
assert.equal(hit.results[0].id, records[0].id);
const hitAgain = searchFts(dbPath, '缓存一致性', { limit: 10 });
assert.equal(hitAgain.results[0].id, records[0].id);
assert.ok(searchCacheStats().hits >= 1);
assert.equal(searchFts(dbPath, 'PAGE-8', { limit: 10 }).results[0].id, records[1].id);
assert.equal(searchFts(dbPath, '不存在的词', { limit: 10 }).results.length, 0);

const indexed = recall(cfg, { query: '缓存一致性', k: 5, workspace: 'D:/DSH' });
const baseline = recall(cfg, { query: '缓存一致性', k: 5, workspace: 'D:/DSH', useIndex: false });
assert.equal(indexed.results[0].id, records[0].id);
assert.deepEqual(indexed.results.map((item) => item.id), baseline.results.map((item) => item.id));
assert.match(indexed.results[0].reasons.join(','), /fts-candidate/);

const third = {
  ...records[1],
  id: 'rec-20261026-000000-0003',
  title: 'Vega 审计日志 设计',
  gist: 'Vega 审计日志方案，编号 AUDIT-9。',
  key_points: ['审计日志'],
  aliases: ['Vega 审计旧称'],
  tags: ['vega', 'audit'],
  entities: ['Vega'],
  project: 'Vega',
  dir: 'records/2026/10/rec-20261026-000000-0003',
};
records.push(third);
fs.writeFileSync(catalogPath, JSON.stringify({ schema: 1, generated_at: now, counts: { records: records.length }, records }));
const refreshed = refreshFtsRecord(cfg, third);
assert.equal(refreshed.updated, true);
assert.equal(isIndexFresh(cfg), true);
assert.equal(searchFts(dbPath, 'AUDIT-9', { limit: 10 }).results[0].id, third.id);

fs.appendFileSync(catalogPath, ' ');
assert.equal(isIndexFresh(cfg), false);
const fallback = recall(cfg, { query: '缓存一致性', k: 5, workspace: 'D:/DSH' });
assert.equal(fallback.results[0].id, records[0].id);

fs.rmSync(root, { recursive: true, force: true });
console.log('fts smoke: ok');
