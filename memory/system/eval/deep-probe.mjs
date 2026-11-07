import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const lib = pathToFileURL(path.resolve(import.meta.dirname, '..', 'lib')).href;
const { loadConfig, loadCatalog, loadRecord } = await import(`${lib}/store.mjs`);
const { buildFtsIndex, searchFts } = await import(`${lib}/fts.mjs`);
const cfg = loadConfig();
const records = loadCatalog(cfg).records.map((record) => {
  const full = loadRecord(cfg, record.id);
  return { ...record, gist: full.digest, key_points: [] };
});
const db = path.join(os.tmpdir(), `mem-deep-probe-${process.pid}.db`);
const build = buildFtsIndex(records, db);
const cases = [
  ['怎么防止旧结论压住新任务', 'rec-20261026-181541-6e67'],
  ['session reference @', 'rec-20261026-181541-6e67'],
  ['官方 read grep 路由', 'rec-20261026-181541-6e67'],
];
const results = cases.map(([query, want]) => {
  const search = searchFts(db, query, { limit: 10 });
  const ids = search.results.map((row) => row.id);
  return { query, want, rank: ids.indexOf(want) + 1, ids };
});
fs.rmSync(db, { force: true });
console.log(JSON.stringify({ build, results }, null, 2));
