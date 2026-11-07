import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const lib = pathToFileURL(path.resolve(import.meta.dirname, '..', 'lib')).href;
const { loadConfig, createRecord } = await import(`${lib}/store.mjs`);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-doctor-test-'));
for (const dir of ['index', 'sessions', 'projection', 'records', 'views', 'cache', 'inbox', 'system']) {
  fs.mkdirSync(path.join(root, dir), { recursive: true });
}
fs.writeFileSync(path.join(root, 'index', 'sessions.json'), JSON.stringify({ schema: 1, sessions: [] }));
fs.writeFileSync(path.join(root, 'ledger.json'), JSON.stringify({ schema: 1, entries: [] }));
const cfg = loadConfig({ root, sessionsRoot: path.join(root, 'sessions'), projectionRoot: path.join(root, 'projection') });
const record = createRecord(cfg, { title: 'Integrity test', gist: 'digest hash test', kind: 'episode', workspace: 'D:/DSH' });
const memBin = path.resolve(import.meta.dirname, '..', 'bin', 'mem.mjs');
const run = () => spawnSync(process.execPath, [
  memBin, 'doctor', '--root', root,
  '--sessions-root', path.join(root, 'sessions'),
  '--projection-root', path.join(root, 'projection'),
], { encoding: 'utf8', windowsHide: true });

const clean = run();
assert.equal(clean.status, 0, clean.stdout + clean.stderr);
const digest = path.join(record.dir, 'digest.md');
fs.appendFileSync(digest, '\n- tampered\n');
const tampered = run();
assert.notEqual(tampered.status, 0);
assert.match(tampered.stdout, /完整性 hash 不匹配/);

fs.rmSync(root, { recursive: true, force: true });
console.log('doctor integrity smoke: ok');
