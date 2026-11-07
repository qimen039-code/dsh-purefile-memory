import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const lib = pathToFileURL(path.resolve(import.meta.dirname, '..', 'lib')).href;
const { loadConfig, loadCatalog } = await import(`${lib}/store.mjs`);
const { candidateGistFromSession } = await import(`${lib}/inbox.mjs`);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-inbox-'));
for (const dir of ['index', 'sessions', 'projection', 'records', 'views', 'cache', 'inbox', 'system']) {
  fs.mkdirSync(path.join(root, dir), { recursive: true });
}
fs.writeFileSync(path.join(root, 'index', 'sessions.json'), JSON.stringify({ schema: 1, sessions: [] }));
fs.writeFileSync(path.join(root, 'ledger.json'), JSON.stringify({ schema: 1, entries: [] }));
const cfg = loadConfig({ root, sessionsRoot: path.join(root, 'sessions'), projectionRoot: path.join(root, 'projection') });
assert.equal(candidateGistFromSession({ title: 'T', gist: 'T — body text' }), 'body text');
assert.equal(candidateGistFromSession({ title: 'T', gist: 'plain gist' }), 'plain gist');
const memBin = path.resolve(import.meta.dirname, '..', 'bin', 'mem.mjs');
const args = (tail) => [memBin, ...tail, '--root', root, '--sessions-root', path.join(root, 'sessions'), '--projection-root', path.join(root, 'projection')];
const run = (tail) => spawnSync(process.execPath, args(tail), { encoding: 'utf8', windowsHide: true });

const added = run(['inbox', 'add', '--title', 'Draft project memory', '--gist', 'candidate only']);
assert.equal(added.status, 0, added.stdout + added.stderr);
const id = added.stdout.match(/candidate: (inbox-[^\s]+)/)?.[1];
assert.ok(id, added.stdout);
assert.equal(loadCatalog(cfg).records.length, 0, 'candidate must not become canonical');

const list = run(['inbox', 'list']);
assert.match(list.stdout, new RegExp(id));

const promoted = run(['inbox', 'promote', id]);
assert.equal(promoted.status, 0, promoted.stdout + promoted.stderr);
assert.equal(loadCatalog(cfg).records.length, 1);
assert.doesNotMatch(run(['inbox', 'list']).stdout, new RegExp(id));

const second = run(['inbox', 'add', '--title', 'Drop me', '--gist', 'drop candidate']);
const secondId = second.stdout.match(/candidate: (inbox-[^\s]+)/)?.[1];
assert.ok(secondId);
assert.equal(run(['inbox', 'drop', secondId]).status, 0);

const duplicate = run(['inbox', 'add', '--title', 'Draft project memory', '--gist', 'duplicate title']);
const duplicateId = duplicate.stdout.match(/candidate: (inbox-[^\s]+)/)?.[1];
assert.ok(duplicateId);
assert.notEqual(run(['inbox', 'promote', duplicateId]).status, 0);
assert.equal(run(['inbox', 'promote', duplicateId, '--force']).status, 0);

const editable = run(['inbox', 'add', '--title', 'Draft edit', '--gist', 'before', '--kind', 'project', '--temperature', 'sealed']);
const editableId = editable.stdout.match(/candidate: (inbox-[^\s]+)/)?.[1];
assert.ok(editableId);
assert.equal(run(['inbox', 'update', editableId, '--title', 'Draft edited', '--gist', 'after']).status, 0);
assert.match(run(['inbox', 'show', editableId]).stdout, /Draft edited/);
assert.equal(run(['inbox', 'promote', editableId]).status, 0);
assert.ok(loadCatalog(cfg).records.some((record) => record.title === 'Draft edited' && record.kind === 'project' && record.temperature === 'sealed'));

fs.rmSync(root, { recursive: true, force: true });
console.log('inbox smoke: ok');
