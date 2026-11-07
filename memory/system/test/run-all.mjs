import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const node = process.execPath;
const cases = [
  ['core selftest', [path.join(root, 'bin', 'mem.mjs'), 'selftest']],
  ['fts index', [path.join(root, 'test', 'fts-smoke.mjs')]],
  ['fts store', [path.join(root, 'test', 'fts-store-smoke.mjs')]],
  ['fts filter', [path.join(root, 'test', 'fts-filter-smoke.mjs')]],
  ['concurrency', [path.join(root, 'test', 'concurrency-smoke.mjs')]],
  ['doctor integrity', [path.join(root, 'test', 'doctor-integrity.mjs')]],
  ['schema', [path.join(root, 'test', 'schema-smoke.mjs')]],
  ['similar', [path.join(root, 'test', 'similar-smoke.mjs')]],
  ['inbox', [path.join(root, 'test', 'inbox-smoke.mjs')]],
  ['view', [path.join(root, 'test', 'view-smoke.mjs')]],
  ['bridge', [path.join(root, 'test', 'bridge-smoke.mjs')]],
  ['plugin', [path.join(root, 'test', 'plugin-smoke.mjs')]],
];

let failed = 0;
for (const [label, args] of cases) {
  const result = spawnSync(node, args, { encoding: 'utf8', windowsHide: true });
  if (result.status === 0) {
    console.log(`PASS ${label}`);
    continue;
  }
  failed += 1;
  console.error(`FAIL ${label}`);
  if (result.stdout) console.error(result.stdout.trim());
  if (result.stderr) console.error(result.stderr.trim());
}
if (failed > 0) {
  console.error(`test-all: ${failed} failed`);
  process.exit(1);
}
console.log('test-all: ok');
