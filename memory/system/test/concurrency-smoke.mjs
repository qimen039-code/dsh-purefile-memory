import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const lib = pathToFileURL(path.resolve(import.meta.dirname, '..', 'lib')).href;
const { loadConfig, createRecord, loadRecord } = await import(`${lib}/store.mjs`);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-race-test-'));
for (const dir of ['index', 'sessions', 'projection', 'records', 'views', 'cache', 'inbox', 'system']) {
  fs.mkdirSync(path.join(root, dir), { recursive: true });
}
fs.writeFileSync(path.join(root, 'index', 'sessions.json'), JSON.stringify({ schema: 1, sessions: [] }));
fs.writeFileSync(path.join(root, 'ledger.json'), JSON.stringify({ schema: 1, entries: [] }));
const cfg = loadConfig({ root, sessionsRoot: path.join(root, 'sessions'), projectionRoot: path.join(root, 'projection') });
const created = createRecord(cfg, { title: 'Race test', gist: 'concurrent annotate', kind: 'episode', workspace: 'D:/DSH' });
const id = created.meta.id;
const memBin = path.resolve(import.meta.dirname, '..', 'bin', 'mem.mjs');

function annotate(text) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      memBin, 'annotate', id, '--kind', 'correction', '--text', text,
      '--root', root,
      '--sessions-root', path.join(root, 'sessions'),
      '--projection-root', path.join(root, 'projection'),
    ], { stdio: 'ignore', windowsHide: true });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`annotate exited ${code}`)));
  });
}

const before = loadRecord(cfg, id).meta.corrections?.length ?? 0;
await Promise.all([annotate('A'), annotate('B')]);
const after = loadRecord(cfg, id).meta.corrections?.length ?? 0;
assert.equal(after, before + 2, 'two concurrent annotations must both be preserved');

fs.rmSync(root, { recursive: true, force: true });
console.log('concurrency smoke: ok');
