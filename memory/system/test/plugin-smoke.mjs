import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const { apply } = await import(pathToFileURL('D:/DSH/plugins/dsh-memory-vault/lib/index.js').href);
const tools = new Map();
apply({ tools: { register(tool) { tools.set(tool.name, tool); } } });

assert.equal(tools.size, 6);
for (const name of ['mem_recall', 'mem_check', 'mem_route', 'mem_brief', 'mem_session', 'mem_status']) {
  assert.ok(tools.has(name), `missing tool ${name}`);
}

const status = await tools.get('mem_status').execute({});
assert.match(status.text, /records:/);
assert.match(status.text, /sessions:/);

const recalled = await tools.get('mem_recall').execute({ query: 'ACCF 隔离', k: 3 });
assert.match(recalled.text, /记忆召回/);
assert.match(recalled.text, /rec-20261026-181458-3504/);
assert.match(recalled.text, /fts-candidate/);

const checked = await tools.get('mem_check').execute({ query: 'ACCF 隔离', k: 2 });
assert.match(checked.text, /相似记录/);
assert.match(checked.text, /rec-20261026-181458-3504/);

const routed = await tools.get('mem_route').execute({ id: 'rec-20261026-181541-6e67', layer: 'l1' });
assert.match(routed.text, /layer: l1/);
assert.match(routed.text, /digest\.md/);

const session = await tools.get('mem_session').execute({ id: '441ffb80', mode: 'show', last: 1 });
assert.match(session.text, /卸载旧DSH插件并恢复官方版/);
assert.match(session.text, /dsh-session:/);

const found = await tools.get('mem_session').execute({ mode: 'find', query: '记忆系统' });
assert.match(found.text, /session-b2dbae8c/);

const brief = await tools.get('mem_brief').execute({ session: 'plugin-smoke-test' });
assert.match(brief.text, /记忆 brief/);

// Keep the production injection ledger free of test-only sessions.
const injectionFile = 'D:/DSH/memory/index/injection.json';
if (fs.existsSync(injectionFile)) {
  const injection = JSON.parse(fs.readFileSync(injectionFile, 'utf8'));
  delete injection.sessions?.['plugin-smoke-test'];
  fs.writeFileSync(injectionFile, `${JSON.stringify(injection, null, 2)}\n`, 'utf8');
}

console.log('plugin smoke: ok');
