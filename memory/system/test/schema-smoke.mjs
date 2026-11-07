import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const lib = pathToFileURL(path.resolve(import.meta.dirname, '..', 'lib')).href;
const { loadConfig, createRecord, loadRecord } = await import(`${lib}/store.mjs`);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-schema-test-'));
for (const dir of ['index', 'sessions', 'projection', 'records', 'views', 'cache', 'inbox', 'system']) {
  fs.mkdirSync(path.join(root, dir), { recursive: true });
}
fs.writeFileSync(path.join(root, 'index', 'sessions.json'), JSON.stringify({ schema: 1, sessions: [] }));
fs.writeFileSync(path.join(root, 'ledger.json'), JSON.stringify({ schema: 1, entries: [] }));
const cfg = loadConfig({ root, sessionsRoot: path.join(root, 'sessions'), projectionRoot: path.join(root, 'projection') });
const record = createRecord(cfg, { title: 'Schema test', gist: 'schema guard', kind: 'episode', workspace: 'D:/DSH' });
assert.equal(record.meta.schema, 1);

const metaPath = path.join(record.dir, 'meta.json');
const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
meta.schema = 999;
fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
assert.throws(() => loadRecord(cfg, record.meta.id), (error) => error.code === 'UNSUPPORTED_SCHEMA');

const memBin = path.resolve(import.meta.dirname, '..', 'bin', 'mem.mjs');
const result = spawnSync(process.execPath, [
  memBin, 'doctor', '--root', root,
  '--sessions-root', path.join(root, 'sessions'),
  '--projection-root', path.join(root, 'projection'),
], { encoding: 'utf8', windowsHide: true });
assert.notEqual(result.status, 0);
assert.match(result.stdout, /UNSUPPORTED_SCHEMA|schema/i);

fs.rmSync(root, { recursive: true, force: true });
console.log('schema smoke: ok');
