import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const lib = pathToFileURL(path.resolve(import.meta.dirname, '..', 'lib')).href;
const { loadConfig, createRecord, loadCatalog, updateRecord } = await import(`${lib}/store.mjs`);
const { buildFtsIndex, indexFileFor, isIndexFresh, searchFts } = await import(`${lib}/fts.mjs`);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-fts-store-'));
for (const dir of ['index', 'sessions', 'projection', 'records', 'views', 'cache', 'inbox', 'system']) {
  fs.mkdirSync(path.join(root, dir), { recursive: true });
}
fs.writeFileSync(path.join(root, 'index', 'sessions.json'), JSON.stringify({ schema: 1, sessions: [] }));
fs.writeFileSync(path.join(root, 'ledger.json'), JSON.stringify({ schema: 1, entries: [] }));
const cfg = loadConfig({ root, sessionsRoot: path.join(root, 'sessions'), projectionRoot: path.join(root, 'projection') });

const mk = (title, gist) => createRecord(cfg, { title, gist, kind: 'episode', workspace: 'D:/DSH' });
mk('Orion 缓存一致性 设计', 'Orion 缓存一致性方案 CACHE-1。');
mk('Lumen 分页游标 设计', 'Lumen 分页游标方案 PAGE-2。');
const catalogPath = path.join(root, 'index', 'catalog.json');
buildFtsIndex(loadCatalog(cfg).records, indexFileFor(cfg), { catalogPath });
assert.equal(isIndexFresh(cfg), true);

const created = mk('Terra 告警抑制 设计', 'Terra 告警抑制方案 ALERT-3。');
assert.equal(isIndexFresh(cfg), true);
assert.equal(searchFts(indexFileFor(cfg), 'ALERT-3', { limit: 10 }).results[0].id, created.meta.id);

updateRecord(cfg, created.meta.id, (meta) => { meta.title = 'Terra 告警抑制 设计 v2'; });
assert.equal(isIndexFresh(cfg), true);
assert.equal(searchFts(indexFileFor(cfg), 'v2', { limit: 10 }).results[0].id, created.meta.id);

fs.rmSync(root, { recursive: true, force: true });
console.log('fts store smoke: ok');
