import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const lib = pathToFileURL(path.resolve(import.meta.dirname, '..', 'lib')).href;
const { loadConfig, createRecord, loadCatalog } = await import(`${lib}/store.mjs`);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-view-'));
for (const dir of ['index', 'sessions', 'projection', 'records', 'views', 'cache', 'inbox', 'system']) {
  fs.mkdirSync(path.join(root, dir), { recursive: true });
}
fs.writeFileSync(path.join(root, 'index', 'sessions.json'), JSON.stringify({ schema: 1, sessions: [] }));
fs.writeFileSync(path.join(root, 'ledger.json'), JSON.stringify({ schema: 1, entries: [] }));
const cfg = loadConfig({ root, sessionsRoot: path.join(root, 'sessions'), projectionRoot: path.join(root, 'projection') });
const record = createRecord(cfg, { title: 'Orion 缓存一致性 设计', gist: 'Orion 缓存一致性方案 CACHE-1', kind: 'project', workspace: 'D:/DSH' });
const before = loadCatalog(cfg).records.length;
const memBin = path.resolve(import.meta.dirname, '..', 'bin', 'mem.mjs');
const run = (tail) => spawnSync(process.execPath, [memBin, ...tail,
  '--root', root,
  '--sessions-root', path.join(root, 'sessions'),
  '--projection-root', path.join(root, 'projection'),
], { encoding: 'utf8', windowsHide: true });

const made = run(['view', '缓存一致性', '--k', '3']);
assert.equal(made.status, 0, made.stdout + made.stderr);
const id = made.stdout.match(/view: (view-[^\s]+)/)?.[1];
assert.ok(id, made.stdout);
assert.equal(loadCatalog(cfg).records.length, before, 'view must not write canonical');

const shown = run(['view', 'show', id]);
assert.equal(shown.status, 0, shown.stdout + shown.stderr);
assert.match(shown.stdout, new RegExp(record.meta.id));
assert.match(shown.stdout, /cache|缓存/i);

const listed = run(['view', 'list']);
assert.match(listed.stdout, new RegExp(id));
assert.equal(run(['view', 'prune', '--keep', '0']).status, 0);
assert.doesNotMatch(run(['view', 'list']).stdout, new RegExp(id));

fs.rmSync(root, { recursive: true, force: true });
console.log('view smoke: ok');
