import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ensureDir, normKey, queryTerms, termsOf } from './util.mjs';

export const FTS_SCHEMA = 5;
const SEARCH_CACHE = new Map();
const SEARCH_CACHE_MAX = 64;
const SEARCH_STATS = { hits: 0, misses: 0, evictions: 0 };

export function searchCacheStats() {
  return { ...SEARCH_STATS, size: SEARCH_CACHE.size };
}

export function clearSearchCache() {
  SEARCH_CACHE.clear();
}

function cacheKey(dbPath, query, options) {
  const stat = fs.statSync(dbPath);
  return JSON.stringify([dbPath, stat.size, stat.mtimeMs, query, options]);
}

function bodyText(record) {
  return [
    ...(record.key_points ?? []),
    ...(record.open_loops ?? []).map((loop) => loop?.question ?? ''),
    ...(record.decisions ?? []).map((decision) => decision?.statement ?? ''),
    record.gist ?? '',
  ].join(' ');
}

function titleText(record) {
  return [record.title ?? '', ...(record.aliases ?? []), ...(record.tags ?? []), ...(record.entities ?? [])].join(' ');
}

function tokensFor(text) {
  return termsOf(String(text ?? ''), { includeSingleCjk: true }).join(' ');
}

export function indexFileFor(cfg) {
  return path.join(cfg.indexDir, 'retrieval.db');
}

function insertRecord(db, record) {
  db.prepare(`
    INSERT INTO docs (id, kind, title, gist, workspace, workspace_key, project, scope, standing, temperature,
      confidence, updated_at, last_touched_at, dir, sensitive, doc_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.kind ?? 'episode',
    record.title ?? '',
    record.gist ?? '',
    record.workspace ?? '',
    normKey(record.workspace ?? ''),
    record.project ?? '',
    record.scope ?? 'workspace',
    record.standing ?? 'current',
    record.temperature ?? 'warm',
    Number(record.confidence ?? 0.5),
    record.updated_at ?? '',
    record.last_touched_at ?? record.updated_at ?? '',
    record.dir ?? '',
    record.privacy?.sensitive ? 1 : 0,
    JSON.stringify(record),
  );
  db.prepare('INSERT INTO docs_fts (id, title_tokens, body_tokens) VALUES (?, ?, ?)')
    .run(record.id, tokensFor(titleText(record)), tokensFor(bodyText(record)));
}

function deleteRecord(db, id) {
  db.prepare('DELETE FROM docs_fts WHERE id = ?').run(id);
  db.prepare('DELETE FROM docs WHERE id = ?').run(id);
}

function markMeta(db, { catalogPath }) {
  const records = db.prepare('SELECT count(*) AS n FROM docs').get().n;
  const set = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
  set.run('schema', String(FTS_SCHEMA));
  set.run('records', String(records));
  if (catalogPath && fs.existsSync(catalogPath)) {
    const stat = fs.statSync(catalogPath);
    set.run('catalog_size', String(stat.size));
    set.run('catalog_mtime_ms', String(stat.mtimeMs));
  }
  return records;
}

export function refreshFtsRecord(cfg, record) {
  const dbPath = indexFileFor(cfg);
  if (!fs.existsSync(dbPath)) return { updated: false, reason: 'no-index' };
  let db;
  try {
    db = new DatabaseSync(dbPath);
    const schema = db.prepare("SELECT value FROM meta WHERE key = 'schema'").get();
    if (Number(schema?.value) !== FTS_SCHEMA) {
      db.close();
      return { updated: false, reason: 'stale-schema' };
    }
    db.exec('BEGIN');
    deleteRecord(db, record.id);
    insertRecord(db, record);
    const records = markMeta(db, { catalogPath: path.join(cfg.indexDir, 'catalog.json') });
    db.exec('COMMIT');
    SEARCH_CACHE.clear();
    return { updated: true, records };
  } catch (error) {
    try { db?.exec('ROLLBACK'); } catch { /* transaction may not have started */ }
    return { updated: false, reason: error.message };
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

export function buildFtsIndex(records, dbPath, { catalogPath = null } = {}) {
  SEARCH_CACHE.clear();
  ensureDir(path.dirname(dbPath));
  fs.rmSync(dbPath, { force: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(`
    CREATE TABLE docs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      gist TEXT NOT NULL,
      workspace TEXT NOT NULL,
      workspace_key TEXT NOT NULL,
      project TEXT NOT NULL,
      scope TEXT NOT NULL,
      standing TEXT NOT NULL,
      temperature TEXT NOT NULL,
      confidence REAL NOT NULL,
      updated_at TEXT NOT NULL,
      last_touched_at TEXT NOT NULL,
      dir TEXT NOT NULL,
      sensitive INTEGER NOT NULL DEFAULT 0,
      doc_json TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE docs_fts USING fts5(
      id UNINDEXED,
      title_tokens,
      body_tokens,
      tokenize = 'unicode61'
    );
    CREATE INDEX docs_workspace ON docs (workspace_key, standing, temperature, sensitive);
    CREATE INDEX docs_kind ON docs (kind);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const started = performance.now();
  db.exec('BEGIN');
  for (const record of records) {
    insertRecord(db, record);
  }
  db.exec('COMMIT');
  markMeta(db, { catalogPath });
  db.close();
  return { records: records.length, build_ms: performance.now() - started, dbPath };
}

export function readIndexMeta(dbPath) {
  if (!fs.existsSync(dbPath)) return null;
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare('SELECT key, value FROM meta').all();
    const meta = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    return {
      schema: Number(meta.schema),
      records: Number(meta.records),
      catalog_size: meta.catalog_size === undefined ? null : Number(meta.catalog_size),
      catalog_mtime_ms: meta.catalog_mtime_ms === undefined ? null : Number(meta.catalog_mtime_ms),
    };
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

export function isIndexFresh(cfg) {
  const dbPath = indexFileFor(cfg);
  const catalogPath = path.join(cfg.indexDir, 'catalog.json');
  if (!fs.existsSync(dbPath) || !fs.existsSync(catalogPath)) return false;
  const meta = readIndexMeta(dbPath);
  if (!meta || meta.schema !== FTS_SCHEMA) return false;
  const stat = fs.statSync(catalogPath);
  return meta.catalog_size === stat.size
    && meta.catalog_mtime_ms !== null
    && Math.abs(meta.catalog_mtime_ms - stat.mtimeMs) < 2;
}

function quoteToken(token) {
  return `"${String(token).replaceAll('"', '""')}"`;
}

export function searchFts(dbPath, query, {
  limit = 100,
  workspace = null,
  allWorkspaces = false,
  history = false,
  includeSealed = true,
  kinds = null,
  allowSensitive = false,
} = {}) {
  const { strong } = queryTerms(query);
  const terms = [...new Set(strong)].slice(0, 64);
  if (terms.length === 0) return { results: [], took_ms: 0, terms: [] };
  const key = cacheKey(dbPath, query, { limit, workspace, allWorkspaces, history, includeSealed, kinds, allowSensitive });
  const cached = SEARCH_CACHE.get(key);
  if (cached) {
    SEARCH_STATS.hits += 1;
    return cached;
  }
  SEARCH_STATS.misses += 1;
  const match = terms.map(quoteToken).join(' OR ');
  const clauses = ['docs_fts MATCH ?'];
  const params = [match];
  if (workspace && !allWorkspaces) {
    clauses.push("(d.workspace_key = ? OR d.scope = 'global')");
    params.push(normKey(workspace));
  }
  if (!history) {
    clauses.push("d.standing = 'current'");
    clauses.push("d.temperature <> 'frozen'");
  }
  if (!includeSealed) clauses.push("d.temperature NOT IN ('sealed', 'frozen')");
  if (kinds && kinds.length > 0) {
    clauses.push(`d.kind IN (${kinds.map(() => '?').join(', ')})`);
    params.push(...kinds);
  }
  if (!allowSensitive) clauses.push('d.sensitive = 0');
  params.push(Math.max(1, Math.min(1000, limit)));
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec('PRAGMA cache_size = -64000');
  db.exec('PRAGMA temp_store = MEMORY');
  db.exec('PRAGMA mmap_size = 268435456');
  const started = performance.now();
  const rows = db.prepare(`
    SELECT d.id, d.kind, d.title, d.gist, d.workspace, d.project, d.scope, d.standing,
      d.temperature, d.confidence, d.updated_at, d.last_touched_at, d.dir, d.sensitive, d.doc_json,
      bm25(docs_fts, 8.0, 1.0) AS rank
    FROM docs_fts
    JOIN docs d ON d.id = docs_fts.id
    WHERE ${clauses.join(' AND ')}
    ORDER BY rank
    LIMIT ?
  `).all(...params);
  db.close();
  const result = {
    results: rows.map((row) => ({ ...row, fts_score: -Number(row.rank) })),
    took_ms: performance.now() - started,
    terms,
  };
  SEARCH_CACHE.set(key, result);
  if (SEARCH_CACHE.size > SEARCH_CACHE_MAX) {
    const oldest = SEARCH_CACHE.keys().next().value;
    SEARCH_CACHE.delete(oldest);
    SEARCH_STATS.evictions += 1;
  }
  return result;
}
