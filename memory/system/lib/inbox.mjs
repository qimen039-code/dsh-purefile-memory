import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, newId, nowIso, readJson, writeJson } from './util.mjs';
import { createRecord, loadCatalog } from './store.mjs';

function candidatePath(cfg, id) {
  return path.join(cfg.inboxDir, `${id}.json`);
}

export function listCandidates(cfg) {
  ensureDir(cfg.inboxDir);
  return fs.readdirSync(cfg.inboxDir)
    .filter((name) => /^inbox-.*\.json$/.test(name))
    .map((name) => readJson(path.join(cfg.inboxDir, name), null))
    .filter((item) => item && item.status === 'pending')
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

export function candidateGistFromSession(session) {
  const raw = String(session?.gist ?? '');
  const prefix = `${session?.title ?? ''} — `;
  if (session?.title && raw.startsWith(prefix)) return raw.slice(prefix.length);
  return raw;
}

export function createCandidate(cfg, {
  title,
  gist,
  keyPoints = [],
  tags = [],
  kind = 'episode',
  temperature = 'warm',
  body = '',
  source = '',
  sessionRefs = [],
  workspace = cfg.defaultWorkspace,
} = {}) {
  if (!title || !gist) throw new Error('inbox add 需要 title 和 gist');
  ensureDir(cfg.inboxDir);
  const id = newId('inbox');
  const candidate = {
    schema: 1,
    id,
    status: 'pending',
    title: String(title),
    gist: String(gist),
    kind: ['episode', 'thread', 'project', 'reference', 'decision'].includes(kind) ? kind : 'episode',
    temperature: ['hot', 'warm', 'sealed', 'frozen'].includes(temperature) ? temperature : 'warm',
    key_points: keyPoints,
    tags,
    body,
    source,
    session_refs: sessionRefs,
    workspace,
    created_at: nowIso(),
  };
  writeJson(candidatePath(cfg, id), candidate);
  return candidate;
}

export function loadCandidate(cfg, id) {
  const candidate = readJson(candidatePath(cfg, id), null);
  if (!candidate) throw new Error(`候选不存在：${id}`);
  return candidate;
}

export function dropCandidate(cfg, id) {
  const candidate = loadCandidate(cfg, id);
  fs.rmSync(candidatePath(cfg, id), { force: true });
  return candidate;
}

export function updateCandidate(cfg, id, patch = {}) {
  const candidate = loadCandidate(cfg, id);
  const allowed = ['title', 'gist', 'kind', 'temperature', 'key_points', 'tags', 'body', 'source', 'workspace'];
  for (const key of allowed) {
    if (patch[key] !== undefined) candidate[key] = patch[key];
  }
  candidate.updated_at = nowIso();
  writeJson(candidatePath(cfg, id), candidate);
  return candidate;
}

export function promoteCandidate(cfg, id, { force = false } = {}) {
  const candidate = loadCandidate(cfg, id);
  if (!force) {
    const duplicate = loadCatalog(cfg).records.find((item) =>
      item.standing === 'current' && String(item.title).trim().toLowerCase() === String(candidate.title).trim().toLowerCase());
    if (duplicate) {
      throw new Error(`已有同标题 current 记录：${duplicate.id}；用 --force 才允许重复`);
    }
  }
  const created = createRecord(cfg, {
    title: candidate.title,
    gist: candidate.gist,
    kind: candidate.kind || 'episode',
    temperature: candidate.temperature || 'warm',
    workspace: candidate.workspace || cfg.defaultWorkspace,
    tags: candidate.tags ?? [],
    key_points: candidate.key_points ?? [],
    session_refs: candidate.session_refs ?? [],
    body: candidate.body || candidate.gist,
    owner: 'agent',
  });
  fs.rmSync(candidatePath(cfg, id), { force: true });
  return { candidate, created };
}
