import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeDataset, makeScaleDataset } from './dataset.mjs';

const lib = pathToFileURL(path.resolve(import.meta.dirname, '..', 'lib')).href;
const { loadConfig } = await import(`${lib}/store.mjs`);
const { recall } = await import(`${lib}/recall.mjs`);
const { scoreRecordForQuery } = await import(`${lib}/recall.mjs`);
const { buildFtsIndex, searchFts } = await import(`${lib}/fts.mjs`);
const { queryTerms, scoreFields, daysSince, normKey } = await import(`${lib}/util.mjs`);

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem-eval-'));
  for (const dir of ['index', 'sessions', 'projection', 'records', 'views', 'cache', 'inbox', 'system']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(root, 'index', 'sessions.json'), JSON.stringify({ schema: 1, sessions: [] }));
  fs.writeFileSync(path.join(root, 'ledger.json'), JSON.stringify({ schema: 1, entries: [] }));
  return root;
}

function configFor(root) {
  return loadConfig({
    root,
    sessionsRoot: path.join(root, 'sessions'),
    projectionRoot: path.join(root, 'projection'),
  });
}

function writeCatalog(root, records) {
  fs.writeFileSync(path.join(root, 'index', 'catalog.json'), JSON.stringify({
    schema: 1,
    generated_at: new Date().toISOString(),
    counts: { records: records.length },
    records,
  }));
}

function exactBonus(query, fields) {
  const needle = String(query ?? '').trim().toLowerCase();
  if (!needle) return 0;
  let bonus = 0;
  for (const field of fields) {
    const text = String(field.text ?? '').toLowerCase();
    if (!text) continue;
    if (text === needle) bonus += 8;
    else if (text.includes(needle)) bonus += 4;
  }
  return bonus;
}

function lexicalScore(record, query) {
  const fields = [
    { text: String(record.title ?? '').toLowerCase(), weight: 9 },
    { text: (record.aliases ?? []).join(' ').toLowerCase(), weight: 8 },
    { text: (record.tags ?? []).join(' ').toLowerCase(), weight: 4 },
    { text: (record.entities ?? []).join(' ').toLowerCase(), weight: 4 },
    { text: String(record.gist ?? '').toLowerCase(), weight: 3 },
    { text: (record.key_points ?? []).join(' ').toLowerCase(), weight: 2 },
  ];
  const base = scoreFields(queryTerms(query), fields);
  const bonus = exactBonus(query, fields);
  if (base.score === 0 && bonus === 0) return 0;
  const coverage = base.strongTotal > 0 ? base.strongHits / base.strongTotal : 1;
  return (base.score + bonus) * (0.65 + 0.35 * coverage);
}

function metaScore(record, workspace) {
  let score = (record.confidence ?? 0.5) * 0.8;
  if (normKey(record.workspace) === normKey(workspace)) score += 1.2;
  if (record.temperature === 'hot') score += 1;
  if (record.temperature === 'sealed') score -= 1.5;
  if (record.standing !== 'current') score -= 6;
  const days = daysSince(record.updated_at);
  if (Number.isFinite(days)) {
    if (days <= 3) score += 1.5;
    else if (days <= 14) score += 0.8;
    else if (days <= 60) score += 0.2;
  }
  return score;
}

function filterRows(rows, workspace, recordById) {
  return rows.filter((row) => {
    const record = recordById.get(row.id);
    if (!record) return false;
    if (normKey(record.workspace) !== normKey(workspace)) return false;
    if (record.standing !== 'current') return false;
    if (record.temperature === 'frozen') return false;
    if (record.privacy?.sensitive) return false;
    return true;
  });
}

function rankRows(mode, rows, query, workspace, recordById, cfg) {
  const filtered = filterRows(rows, workspace, recordById);
  if (mode === 'fts') return filtered;
  if (mode === 'fts_meta') {
    return [...filtered].sort((a, b) => (b.fts_score + metaScore(recordById.get(b.id), workspace)) - (a.fts_score + metaScore(recordById.get(a.id), workspace)));
  }
  if (mode === 'fts_exact') {
    return [...filtered]
      .map((row) => {
        const record = JSON.parse(row.doc_json);
        const scored = scoreRecordForQuery(record, query, cfg, workspace);
        return { ...row, exact_score: scored.score };
      })
      .sort((a, b) => b.exact_score - a.exact_score);
  }
  return [...filtered].sort((a, b) => {
    const aRecord = recordById.get(a.id);
    const bRecord = recordById.get(b.id);
    const aScore = lexicalScore(aRecord, query) + metaScore(aRecord, workspace) + a.fts_score * 0.05;
    const bScore = lexicalScore(bRecord, query) + metaScore(bRecord, workspace) + b.fts_score * 0.05;
    return bScore - aScore;
  });
}

function metrics(rows) {
  const n = rows.length;
  const top1 = rows.filter((row) => row.rank === 1).length;
  const top3 = rows.filter((row) => row.rank >= 1 && row.rank <= 3).length;
  const mrr = rows.reduce((sum, row) => sum + (row.rank > 0 ? 1 / row.rank : 0), 0) / n;
  const latencies = rows.map((row) => row.ms).sort((a, b) => a - b);
  return {
    n,
    top1: +(top1 / n).toFixed(3),
    top3: +(top3 / n).toFixed(3),
    mrr: +mrr.toFixed(3),
    avg_ms: +(latencies.reduce((a, b) => a + b, 0) / n).toFixed(2),
    p50_ms: +latencies[Math.floor(n * 0.5)].toFixed(2),
    max_ms: +Math.max(...latencies).toFixed(2),
  };
}

async function evaluateQuality(dataset) {
  const { records, queries } = dataset;
  const root = makeRoot();
  writeCatalog(root, records);
  const cfg = configFor(root);
  const recordById = new Map(records.map((record) => [record.id, record]));
  const dbPath = path.join(root, 'index', 'retrieval.db');
  const build = buildFtsIndex(records, dbPath);

  const modes = ['baseline', 'fts', 'fts_meta', 'fts_exact', 'fts_rerank'];
  const rows = [];
  for (const item of queries) {
    for (const mode of modes) {
      const start = performance.now();
      let ids = [];
      let candidates = 0;
      if (mode === 'baseline') {
        const result = recall(cfg, { query: item.query, k: 10, workspace: 'D:/DSH' });
        ids = result.results.filter((entry) => entry.type === 'record').map((entry) => entry.id);
        candidates = result.candidates;
      } else {
        const search = searchFts(dbPath, item.query, { limit: 100 });
        candidates = search.results.length;
        ids = rankRows(mode, search.results, item.query, 'D:/DSH', recordById, cfg).slice(0, 10).map((row) => row.id);
      }
      const ms = performance.now() - start;
      rows.push({ ...item, mode, rank: ids.indexOf(item.want) + 1, ids, candidates, ms });
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
  return { build, rows };
}

async function evaluateScale(n) {
  const records = makeScaleDataset(n);
  const root = makeRoot();
  writeCatalog(root, records);
  const cfg = configFor(root);
  const recordById = new Map(records.map((record) => [record.id, record]));
  const dbPath = path.join(root, 'index', 'retrieval.db');
  const build = buildFtsIndex(records, dbPath);
  const query = records[Math.floor(n / 2)].title;
  const baseline = [];
  const fts = [];
  const ftsMeta = [];
  const ftsExact = [];
  for (let i = 0; i < 3; i += 1) {
    let start = performance.now();
    recall(cfg, { query, k: 10, workspace: 'D:/DSH' });
    baseline.push(performance.now() - start);
    start = performance.now();
    const result = searchFts(dbPath, query, { limit: 100 });
    fts.push(performance.now() - start);
    start = performance.now();
    rankRows('fts_meta', result.results, query, 'D:/DSH', recordById, cfg);
    ftsMeta.push(performance.now() - start);
    start = performance.now();
    rankRows('fts_exact', result.results, query, 'D:/DSH', recordById, cfg);
    ftsExact.push(performance.now() - start);
  }
  fs.rmSync(root, { recursive: true, force: true });
  return {
    n,
    build_ms: +build.build_ms.toFixed(1),
    baseline_ms: +(baseline.reduce((a, b) => a + b, 0) / baseline.length).toFixed(1),
    fts_ms: +(fts.reduce((a, b) => a + b, 0) / fts.length).toFixed(1),
    fts_meta_ms: +(ftsMeta.reduce((a, b) => a + b, 0) / ftsMeta.length).toFixed(1),
    fts_exact_ms: +(ftsExact.reduce((a, b) => a + b, 0) / ftsExact.length).toFixed(1),
  };
}

const quality = await evaluateQuality(makeDataset(1000));
const byMode = {};
for (const mode of ['baseline', 'fts', 'fts_meta', 'fts_exact', 'fts_rerank']) {
  byMode[mode] = metrics(quality.rows.filter((row) => row.mode === mode));
}
const byCategory = {};
for (const category of [...new Set(quality.rows.map((row) => row.category))]) {
  byCategory[category] = {};
  for (const mode of ['baseline', 'fts', 'fts_meta', 'fts_exact', 'fts_rerank']) {
    byCategory[category][mode] = metrics(quality.rows.filter((row) => row.mode === mode && row.category === category));
  }
}
const scale = [];
for (const n of [10000, 100000]) {
  try { scale.push(await evaluateScale(n)); } catch (error) { scale.push({ n, error: error.message }); }
}
const output = { build: quality.build, byMode, byCategory, scale };
fs.writeFileSync(path.resolve(import.meta.dirname, 'latest.json'), `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output, null, 2));
