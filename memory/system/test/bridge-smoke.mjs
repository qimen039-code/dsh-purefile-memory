import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const { apply } = await import(pathToFileURL('D:/DSH/plugins/dsh-memory-ledger/lib/index.js').href);
const tools = new Map();
apply({ tools: { register(tool) { tools.set(tool.name, tool); } } });

const names = [...tools.keys()];
for (const name of ['memory_recall', 'memory_status', 'mem_recall', 'mem_check', 'mem_route', 'mem_brief', 'mem_session', 'mem_status']) {
  assert.ok(names.includes(name), `missing ${name}`);
}
assert.equal(names.length, 8, `expected 8 tools, got ${names.join(', ')}`);

const status = await tools.get('mem_status').execute({});
assert.match(status.text, /root: D:\\DSH\\memory/);
assert.match(status.text, /records: \d+/);

const recalled = await tools.get('mem_recall').execute({ query: 'ACCF 隔离', k: 3 });
assert.match(recalled.text, /rec-20261026-181458-3504/);

const routed = await tools.get('mem_route').execute({ id: 'rec-20261026-181541-6e67', layer: 'l2', category: 'notes' });
assert.match(routed.text, /index\.json/);

const session = await tools.get('mem_session').execute({ id: '441ffb80', mode: 'context', last: 1 });
assert.match(session.text, /接续上下文/);

// Keep the production injection ledger free of test-only sessions.
const injectionFile = 'D:/DSH/memory/index/injection.json';
if (fs.existsSync(injectionFile)) {
  const injection = JSON.parse(fs.readFileSync(injectionFile, 'utf8'));
  delete injection.sessions?.['bridge-smoke-test'];
  fs.writeFileSync(injectionFile, `${JSON.stringify(injection, null, 2)}\n`, 'utf8');
}

console.log('bridge smoke: 8 tools ok');
