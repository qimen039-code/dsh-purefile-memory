import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, newId, nowIso, readJson, sha256File, writeJson } from './util.mjs';

export function viewsDir(cfg) {
  return path.join(cfg.viewsDir, 'recall');
}

export function createView(cfg, { query, workspace, session, result, text }) {
  ensureDir(viewsDir(cfg));
  const id = newId('view');
  const catalog = path.join(cfg.indexDir, 'catalog.json');
  const snapshot = {
    schema: 1,
    id,
    created_at: nowIso(),
    query,
    workspace,
    session: session || null,
    source: {
      catalog_sha256: fs.existsSync(catalog) ? sha256File(catalog) : null,
      record_count: result.candidates ?? 0,
    },
    results: (result.results ?? []).map((item) => ({
      type: item.type,
      id: item.id,
      title: item.title,
      temperature: item.temperature,
      standing: item.standing,
      score: item.score,
      next: item.next,
    })),
    text,
  };
  writeJson(path.join(viewsDir(cfg), `${id}.json`), snapshot);
  return snapshot;
}

export function listViews(cfg) {
  ensureDir(viewsDir(cfg));
  return fs.readdirSync(viewsDir(cfg))
    .filter((name) => /^view-.*\.json$/.test(name))
    .map((name) => readJson(path.join(viewsDir(cfg), name), null))
    .filter(Boolean)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

export function loadView(cfg, id) {
  const views = listViews(cfg);
  if (id === 'latest') {
    if (views.length === 0) throw new Error('还没有 recall view');
    return views[0];
  }
  const match = views.find((view) => view.id === id || view.id.startsWith(id));
  if (!match) throw new Error(`view 不存在：${id}`);
  return match;
}

export function pruneViews(cfg, keep = 50) {
  const views = listViews(cfg);
  const remove = views.slice(Math.max(0, keep));
  for (const view of remove) fs.rmSync(path.join(viewsDir(cfg), `${view.id}.json`), { force: true });
  return remove.length;
}
