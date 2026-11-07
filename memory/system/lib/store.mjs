import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { refreshFtsRecord } from './fts.mjs';
import { lockFileFor, withFileLock } from './lock.mjs';
import {
  MemError,
  appendJsonl,
  atomicWrite,
  dateStamp,
  daysSince,
  ensureDir,
  escapeCell,
  formatBytes,
  isoDay,
  newId,
  normKey,
  nowIso,
  oneLine,
  readJson,
  readJsonl,
  relativeDisplay,
  sha256,
  slugify,
  truncate,
  workspaceKey,
  writeJson,
} from './util.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MEMORY_ROOT = path.resolve(HERE, '..', '..');
const DEFAULT_CONFIG = path.join(MEMORY_ROOT, 'system', 'config.json');

const LAYER_PATHS = {
  l1: 'digest.md',
  l2: 'index.json',
  l3: 'content',
  audit: 'audit',
  readme: 'README.md',
};

const KINDS = new Set(['episode', 'thread', 'project', 'reference', 'decision']);
const STANDINGS = new Set(['current', 'superseded', 'contested', 'retracted', 'expired']);
const TEMPERATURES = new Set(['hot', 'warm', 'sealed', 'frozen']);
export const RECORD_SCHEMA = 1;
export const INDEX_SCHEMA = 1;
const RELATION_INVERSE = {
  supersedes: 'superseded_by',
  superseded_by: 'supersedes',
  contradicts: 'contradicts',
  depends_on: 'depended_on_by',
  depended_on_by: 'depends_on',
  derived_from: 'derived_to',
  derived_to: 'derived_from',
  thread_of: 'has_thread',
  has_thread: 'thread_of',
  episode_of: 'has_episode',
  has_episode: 'episode_of',
  artifact_of: 'has_artifact',
  has_artifact: 'artifact_of',
  related_to: 'related_to',
  answers: 'answers',
  reopens: 'reopens',
};

export function memoryRoot() {
  return MEMORY_ROOT;
}

export function loadConfig(options = {}) {
  const configPath = path.resolve(
    options.configPath ||
    process.env.MEM_CONFIG ||
    DEFAULT_CONFIG,
  );
  const fileConfig = fs.existsSync(configPath) ? readJson(configPath, {}) : {};
  const configuredRoot = options.root || process.env.MEM_ROOT || fileConfig.root || '..';
  const root = path.resolve(path.dirname(configPath), configuredRoot);
  const sessionsRoot = path.resolve(
    options.sessionsRoot ||
    process.env.MEM_SESSIONS_ROOT ||
    fileConfig.sessionsRoot ||
    path.join(os.homedir(), '.dsh', 'sessions'),
  );
  const projectionRoot = path.resolve(
    options.projectionRoot ||
    process.env.MEM_PROJECTION_ROOT ||
    fileConfig.projectionRoot ||
    path.join(os.homedir(), '.dsh', 'storages', 'session_projcache', 'sessions'),
  );

  const cfg = {
    configPath,
    fileConfig,
    root,
    recordsRoot: path.join(root, 'records'),
    sessionsStore: path.join(root, 'sessions'),
    indexDir: path.join(root, 'index'),
    viewsDir: path.join(root, 'views'),
    cacheDir: path.join(root, 'cache'),
    inboxDir: path.join(root, 'inbox'),
    systemDir: path.join(root, 'system'),
    sessionsRoot,
    projectionRoot,
    defaultWorkspace: process.env.MEM_WORKSPACE || fileConfig.defaultWorkspace || process.cwd(),
    zstd: process.env.MEM_ZSTD || fileConfig.zstd || 'auto',
    budgets: {
      gistMax: 260,
      titleMax: 120,
      keyPointMax: 160,
      l1MaxChars: 6000,
      briefMaxChars: 1200,
      recallDefault: 5,
      recallMax: 20,
      sessionShowMaxChars: 24000,
      ...(fileConfig.budgets || {}),
    },
    lifecycle: {
      hotDays: 3,
      warmDays: 14,
      sealDays: 30,
      reviewDays: 90,
      sealMinDigestChars: 300,
      maxHotRecords: 40,
      ...(fileConfig.lifecycle || {}),
    },
    recall: {
      includeSealedByDefault: true,
      sealedPenalty: 1.5,
      maxPerProject: 2,
      deepTopN: 20,
      ...(fileConfig.recall || {}),
    },
  };

  for (const dir of [
    cfg.root,
    cfg.recordsRoot,
    cfg.sessionsStore,
    cfg.indexDir,
    cfg.viewsDir,
    cfg.cacheDir,
    cfg.inboxDir,
    cfg.systemDir,
  ]) {
    ensureDir(dir);
  }
  return cfg;
}

export function recordDirFor(cfg, id) {
  const match = /^rec-(\d{4})(\d{2})(\d{2})-\d{6}-[0-9a-f]{4}$/.exec(id);
  if (!match) throw new MemError(`记录 id 格式错误：${id}`, 'BAD_RECORD_ID');
  return path.join(cfg.recordsRoot, match[1], match[2], id);
}

export function readMeta(dir) {
  const meta = readJson(path.join(dir, 'meta.json'));
  if (!meta) throw new MemError(`meta.json 不存在或为空：${dir}`, 'BAD_RECORD', { dir });
  if (Number(meta.schema) !== RECORD_SCHEMA) {
    throw new MemError(
      `不支持的记录 schema：${meta.schema}（当前支持 ${RECORD_SCHEMA}）`,
      'UNSUPPORTED_SCHEMA',
      { dir, schema: meta.schema, supported: RECORD_SCHEMA },
    );
  }
  return meta;
}

export function readRecordByDir(dir) {
  const meta = readMeta(dir);
  const digestPath = path.join(dir, meta.paths?.l1 || LAYER_PATHS.l1);
  const indexPath = path.join(dir, meta.paths?.l2 || LAYER_PATHS.l2);
  const digest = fs.existsSync(digestPath) ? fs.readFileSync(digestPath, 'utf8') : '';
  const index = fs.existsSync(indexPath) ? readJson(indexPath, null) : null;
  return { meta, dir, digest, index };
}

export function scanRecordDirs(cfg) {
  const dirs = [];
  for (const year of safeReadDirs(cfg.recordsRoot)) {
    if (!/^\d{4}$/.test(path.basename(year))) continue;
    for (const month of safeReadDirs(year)) {
      if (!/^\d{2}$/.test(path.basename(month))) continue;
      for (const record of safeReadDirs(month)) {
        if (fs.existsSync(path.join(record, 'meta.json'))) dirs.push(record);
      }
    }
  }
  return dirs;
}

function safeReadDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

export function scanRecords(cfg) {
  const records = [];
  const errors = [];
  for (const dir of scanRecordDirs(cfg)) {
    try {
      records.push(readRecordByDir(dir));
    } catch (error) {
      errors.push({ dir, error: error.message });
    }
  }
  records.sort((a, b) => String(b.meta.created_at).localeCompare(String(a.meta.created_at)));
  return { records, errors };
}

export function compactRecord(meta) {
  return {
    id: meta.id,
    kind: meta.kind,
    title: meta.title,
    aliases: meta.aliases ?? [],
    gist: meta.gist,
    key_points: meta.key_points ?? [],
    tags: meta.tags ?? [],
    entities: meta.entities ?? [],
    workspace: meta.workspace ?? '',
    project: meta.project ?? '',
    scope: meta.scope ?? 'workspace',
    owner: meta.owner ?? 'agent',
    standing: meta.standing ?? 'current',
    temperature: meta.temperature ?? 'hot',
    confidence: meta.confidence ?? 0.5,
    created_at: meta.created_at,
    updated_at: meta.updated_at,
    last_touched_at: meta.last_touched_at,
    review_state: meta.review_state ?? 'draft',
    review_at: meta.review_at ?? null,
    open_loops: (meta.open_loops ?? []).filter((loop) => loop.status === 'unresolved'),
    decisions: (meta.decisions ?? []).filter((decision) => decision.status !== 'reversed'),
    relations: meta.relations ?? [],
    session_refs: meta.session_refs ?? [],
    privacy: meta.privacy ?? { sensitive: false, injectable: true, redact: [] },
    dir: relativeDisplay(meta._root ?? '', meta._dir ?? ''),
  };
}

export function rebuildCatalog(cfg, { reason = 'manual' } = {}) {
  const { records, errors } = scanRecords(cfg);
  const compact = records.map(({ meta, dir }) => {
    const copy = { ...meta, _root: cfg.root, _dir: dir };
    return compactRecord(copy);
  });
  const counts = {};
  for (const item of compact) {
    counts[item.temperature] = (counts[item.temperature] ?? 0) + 1;
    counts[`standing:${item.standing}`] = (counts[`standing:${item.standing}`] ?? 0) + 1;
  }
  const catalog = {
    schema: INDEX_SCHEMA,
    generated_at: nowIso(),
    reason,
    counts: {
      records: compact.length,
      ...counts,
    },
    errors,
    records: compact,
  };
  writeJson(path.join(cfg.indexDir, 'catalog.json'), catalog);
  const sessionsIndex = readJson(path.join(cfg.indexDir, 'sessions.json'), null);
  const state = {
    schema: INDEX_SCHEMA,
    generated_at: catalog.generated_at,
    record_count: compact.length,
    session_count: sessionsIndex?.sessions?.length ?? 0,
    ledger_count: (loadLedger(cfg).entries ?? []).length,
    errors: errors.length,
    reason,
  };
  writeJson(path.join(cfg.indexDir, 'state.json'), state);
  buildViews(cfg, compact, sessionsIndex);
  return catalog;
}

export function loadCatalog(cfg) {
  const file = path.join(cfg.indexDir, 'catalog.json');
  const catalog = readJson(file, null);
  if (!catalog || !Array.isArray(catalog.records)) return rebuildCatalog(cfg, { reason: 'missing-catalog' });
  if (Number(catalog.schema ?? INDEX_SCHEMA) !== INDEX_SCHEMA) {
    throw new MemError(
      `不支持的 catalog schema：${catalog.schema}（当前支持 ${INDEX_SCHEMA}）`,
      'UNSUPPORTED_SCHEMA',
      { file, schema: catalog.schema, supported: INDEX_SCHEMA },
    );
  }
  return catalog;
}

export function compactToRecord(cfg, item) {
  const dir = path.isAbsolute(item.dir) ? item.dir : path.resolve(cfg.root, item.dir);
  return { meta: { ...item }, dir };
}

export function resolveRecord(cfg, ref) {
  const catalog = loadCatalog(cfg);
  const wanted = String(ref ?? '').trim();
  if (!wanted) throw new MemError('缺少记录 id。', 'MISSING_RECORD_ID');
  const exact = catalog.records.find((item) => item.id === wanted);
  if (exact) return { item: exact, dir: path.resolve(cfg.root, exact.dir) };
  if (wanted.length >= 6) {
    const matches = catalog.records.filter((item) => item.id.startsWith(wanted));
    if (matches.length === 1) {
      return { item: matches[0], dir: path.resolve(cfg.root, matches[0].dir) };
    }
    if (matches.length > 1) {
      throw new MemError(`记录 id 前缀不唯一：${wanted}（${matches.length} 个匹配）`, 'AMBIGUOUS_ID');
    }
  }
  const byAlias = catalog.records.filter((item) =>
    (item.aliases ?? []).some((alias) => String(alias).toLowerCase() === wanted.toLowerCase()));
  if (byAlias.length === 1) return { item: byAlias[0], dir: path.resolve(cfg.root, byAlias[0].dir) };
  throw new MemError(`找不到记录：${wanted}`, 'RECORD_NOT_FOUND');
}

export function loadRecord(cfg, ref) {
  const { item, dir } = resolveRecord(cfg, ref);
  const record = readRecordByDir(dir);
  if (record.meta.id !== item.id) {
    throw new MemError(`目录 ${dir} 的 meta.id 与索引不一致`, 'CATALOG_MISMATCH');
  }
  return record;
}

export function newMeta(cfg, opts = {}) {
  const now = nowIso();
  const scope = opts.scope === 'global' ? 'global' : 'workspace';
  const workspace = scope === 'global'
    ? (opts.workspace || '')
    : (opts.workspace || cfg.defaultWorkspace);
  const id = opts.id || newId('rec');
  const title = oneLine(opts.title || '未命名记忆');
  const gist = oneLine(opts.gist || title);
  const kind = KINDS.has(opts.kind) ? opts.kind : 'episode';
  const openLoops = (opts.open_loops ?? []).map((loop) => {
    if (typeof loop === 'string') {
      return { question: oneLine(loop), status: 'unresolved' };
    }
    return {
      id: loop.id || `loop-${sha256(oneLine(loop.question || '')).slice(0, 8)}`,
      question: oneLine(loop.question || ''),
      status: loop.status || 'unresolved',
      next_action: loop.next_action || '',
      owner: loop.owner || '',
    };
  }).filter((loop) => loop.question);

  return {
    schema: RECORD_SCHEMA,
    id,
    kind,
    title: truncate(title, cfg.budgets.titleMax),
    aliases: (opts.aliases ?? []).map(oneLine).filter(Boolean),
    gist: truncate(gist, cfg.budgets.gistMax),
    key_points: (opts.key_points ?? []).map((point) => oneLine(point)).filter(Boolean)
      .slice(0, 8).map((point) => truncate(point, cfg.budgets.keyPointMax)),
    tags: (opts.tags ?? []).map((tag) => oneLine(tag)).filter(Boolean),
    entities: (opts.entities ?? []).map(oneLine).filter(Boolean),
    workspace,
    project: oneLine(opts.project || ''),
    scope,
    owner: ['user', 'agent', 'tool', 'mixed'].includes(opts.owner) ? opts.owner : 'agent',
    standing: STANDINGS.has(opts.standing) ? opts.standing : 'current',
    temperature: TEMPERATURES.has(opts.temperature) ? opts.temperature : 'hot',
    confidence: Number.isFinite(Number(opts.confidence)) ? Number(opts.confidence) : 0.7,
    disconfirmation: oneLine(opts.disconfirmation ||
      '当出现与上述结论相反的新证据，或用户明确更正时，应修订/取代本条。'),
    created_at: opts.created_at || now,
    updated_at: opts.updated_at || now,
    last_touched_at: opts.last_touched_at || now,
    valid_from: opts.valid_from || now,
    valid_to: opts.valid_to ?? null,
    review_state: ['draft', 'reviewed', 'needs_review'].includes(opts.review_state)
      ? opts.review_state : 'draft',
    review_at: opts.review_at ?? nowIso(new Date(Date.now() + cfg.lifecycle.reviewDays * 86_400_000)),
    open_loops: openLoops,
    decisions: (opts.decisions ?? []).map((decision) => ({
      id: decision.id || `dec-${sha256(oneLine(decision.statement || '')).slice(0, 8)}`,
      statement: oneLine(decision.statement || ''),
      status: decision.status || 'in-force',
      reason: decision.reason || '',
      alternatives: decision.alternatives ?? [],
      evidence: decision.evidence ?? [],
      confidence: Number.isFinite(Number(decision.confidence)) ? Number(decision.confidence) : 0.7,
    })).filter((decision) => decision.statement),
    relations: (opts.relations ?? []).map((relation) => ({
      type: relation.type,
      target: relation.target,
      why: relation.why || '',
    })).filter((relation) => relation.type && relation.target),
    session_refs: (opts.session_refs ?? []).map((ref) => {
      const rawId = String(ref.id ?? '');
      return {
        id: rawId.startsWith('session-') ? rawId : `session-${rawId}`,
        workspace: ref.workspace || workspace,
        turns: ref.turns ?? [],
        captured_at: ref.captured_at || now,
        note: ref.note || '',
      };
    }),
    artifact_refs: (opts.artifact_refs ?? []).map((ref) => ({
      ref: ref.ref,
      kind: ref.kind || '',
      summary: ref.summary || '',
      sha256: ref.sha256 || '',
      copied_to: ref.copied_to || '',
    })),
    corrections: [],
    provenance: {
      created_by: opts.created_by || 'agent',
      evidence_ids: opts.evidence_ids ?? [],
      sources: opts.sources ?? [],
    },
    retention: {
      class: opts.retention_class || 'project',
      review_at: opts.review_at ?? null,
      expires_at: opts.expires_at ?? null,
    },
    privacy: {
      sensitive: Boolean(opts.sensitive),
      injectable: opts.injectable !== false,
      redact: opts.redact ?? [],
    },
    paths: { ...LAYER_PATHS },
    integrity: {
      meta_version: 1,
      digest_sha256: null,
      index_sha256: null,
    },
  };
}

export function digestTemplate(cfg, meta, body = '') {
  const templatePath = path.join(cfg.systemDir, 'templates', 'digest.md');
  let template = fs.existsSync(templatePath) ? fs.readFileSync(templatePath, 'utf8') : '# {{title}}\n\n> {{gist}}\n';
  const values = {
    title: meta.title,
    gist: meta.gist,
    id: meta.id,
    kind: meta.kind,
    temperature: meta.temperature,
    standing: meta.standing,
    workspace: meta.workspace || '(global)',
    project: meta.project || '(none)',
    created_at: meta.created_at,
    updated_at: meta.updated_at,
  };
  let text = template.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_, key) => values[key] ?? '');
  if (body) text += `\n\n## 9. 初始记录\n\n${body}\n`;
  return text;
}

export function indexTemplate(meta) {
  return {
    schema: INDEX_SCHEMA,
    record_id: meta.id,
    generated_at: meta.created_at,
    categories: {
      sessions: [],
      artifacts: [],
      sources: [],
      logs: [],
      decisions: [],
      related_records: [],
      claims: [],
      notes: [],
    },
    locators: [],
  };
}

export function createRecord(cfg, opts = {}) {
  const meta = newMeta(cfg, opts);
  const dir = recordDirFor(cfg, meta.id);
  if (fs.existsSync(dir)) throw new MemError(`记录已存在：${meta.id}`, 'RECORD_EXISTS');
  ensureDir(dir);
  for (const sub of ['content/notes', 'content/transcripts', 'content/artifacts', 'content/sources',
    'content/logs', 'content/decisions', 'audit', 'versions']) {
    ensureDir(path.join(dir, sub));
  }
  const digest = opts.digest || digestTemplate(cfg, meta, opts.body || '');
  const index = opts.index || indexTemplate(meta);

  writeText(path.join(dir, 'digest.md'), digest);
  writeJson(path.join(dir, 'index.json'), index);
  meta.integrity.digest_sha256 = sha256(fs.readFileSync(path.join(dir, 'digest.md')));
  meta.integrity.index_sha256 = sha256(fs.readFileSync(path.join(dir, 'index.json')));
  writeJson(path.join(dir, 'meta.json'), meta);
  appendJsonl(path.join(dir, 'audit', 'events.jsonl'), {
    at: meta.created_at,
    event: 'created',
    id: meta.id,
    note: opts.note || '',
  });
  writeRecordReadme(cfg, dir, meta, digest);
  rebuildCatalog(cfg, { reason: `create:${meta.id}` });
  try {
    refreshFtsRecord(cfg, compactRecord({ ...meta, _root: cfg.root, _dir: dir }));
  } catch {
    // Derived index failure must not fail record creation.
  }
  return { meta, dir };
}

export function writeText(file, text) {
  atomicWrite(file, text.endsWith('\n') ? text : `${text}\n`);
}

export function saveRecord(cfg, record, { event = 'updated', note = '', rebuild = true } = {}) {
  const { meta, dir } = record;
  meta.updated_at = nowIso();
  meta.integrity = meta.integrity || { meta_version: 1 };
  const digestPath = path.join(dir, meta.paths?.l1 || LAYER_PATHS.l1);
  const indexPath = path.join(dir, meta.paths?.l2 || LAYER_PATHS.l2);
  if (fs.existsSync(digestPath)) meta.integrity.digest_sha256 = sha256(fs.readFileSync(digestPath));
  if (fs.existsSync(indexPath)) meta.integrity.index_sha256 = sha256(fs.readFileSync(indexPath));
  writeJson(path.join(dir, 'meta.json'), meta);
  const digest = fs.existsSync(digestPath) ? fs.readFileSync(digestPath, 'utf8') : '';
  writeRecordReadme(cfg, dir, meta, digest);
  appendJsonl(path.join(dir, 'audit', 'events.jsonl'), {
    at: meta.updated_at,
    event,
    id: meta.id,
    note,
  });
  if (rebuild) {
    rebuildCatalog(cfg, { reason: `${event}:${meta.id}` });
    try {
      refreshFtsRecord(cfg, compactRecord({ ...meta, _root: cfg.root, _dir: dir }));
    } catch {
      // The index is a derived cache; a failed refresh must not fail the canonical write.
    }
  }
  return record;
}

export function updateRecord(cfg, ref, mutate, { event = 'updated', note = '' } = {}) {
  const first = loadRecord(cfg, ref);
  return withFileLock(lockFileFor(first.dir), () => {
    const record = loadRecord(cfg, ref);
    const result = mutate(record.meta, record);
    if (result === false) return record;
    return saveRecord(cfg, record, { event, note });
  });
}

export function writeRecordReadme(cfg, dir, meta, digest) {
  const rel = (target) => relativeDisplay(dir, path.join(dir, target));
  const openLoops = (meta.open_loops ?? []).filter((loop) => loop.status === 'unresolved');
  const points = (meta.key_points ?? []).map((point) => `- ${point}`).join('\n') || '- （未填写）';
  const loops = openLoops.length
    ? openLoops.map((loop) => `- ${loop.question}${loop.next_action ? ` → ${loop.next_action}` : ''}`).join('\n')
    : '- 无';
  const relations = (meta.relations ?? []).length
    ? meta.relations.map((relation) => `- \`${relation.type}\` → \`${relation.target}\`${relation.why ? `（${relation.why}）` : ''}`).join('\n')
    : '- 无';
  const corrections = (meta.corrections ?? []).slice(-3).map((item) =>
    `- ${item.at} [${item.kind}] ${item.text}${item.evidence ? `（证据：${item.evidence}）` : ''}`).join('\n');
  const text = `# ${meta.title}

> ${meta.gist}

| 字段 | 值 |
|---|---|
| id | \`${meta.id}\` |
| kind | ${meta.kind} |
| temperature | ${meta.temperature} |
| standing | ${meta.standing} |
| workspace | ${meta.workspace || '(global)'} |
| project | ${meta.project || '(none)'} |
| owner | ${meta.owner} |
| confidence | ${meta.confidence} |
| created | ${meta.created_at} |
| updated | ${meta.updated_at} |
| review | ${meta.review_state}${meta.review_at ? ` · due ${meta.review_at}` : ''} |

## 要点

${points}

## 未闭合

${loops}

## 关系

${relations}

## 最近修正

${corrections || '- 无'}

## 分层导航

- L0 元摘要：[\`meta.json\`](${rel('meta.json')})
- L1 提炼：[digest.md](${rel('digest.md')})
- L2 索引：[index.json](${rel('index.json')})
- L3 分类内容：[content/](${rel('content')})
- 审计：[audit/](${rel('audit')})

\`\`\`text
mem route ${meta.id} --layer l1
mem route ${meta.id} --layer l2 --category artifacts
mem route ${meta.id} --layer l3 --category transcripts
\`\`\`

## L1 开头

${truncate(oneLine(digest), 600)}
`;
  writeText(path.join(dir, 'README.md'), text);
}

export function sealRecord(cfg, ref, { force = false } = {}) {
  const record = loadRecord(cfg, ref);
  const { meta, dir, digest } = record;
  const digestChars = String(digest).trim().length;
  if (!force && digestChars < cfg.lifecycle.sealMinDigestChars) {
    throw new MemError(
      `封存被拒绝：L1 digest 只有 ${digestChars} 字符，低于 ${cfg.lifecycle.sealMinDigestChars}。先补全 digest，或用 --force。`,
      'SEAL_DIGEST_TOO_SHORT',
    );
  }
  const open = (meta.open_loops ?? []).filter((loop) => loop.status === 'unresolved');
  if (!force && open.length > 0) {
    throw new MemError(
      `封存被拒绝：还有 ${open.length} 个未闭合问题。先关闭它们，或用 --force 保留为封存线索。`,
      'SEAL_OPEN_LOOPS',
    );
  }
  meta.temperature = 'sealed';
  meta.review_state = 'reviewed';
  meta.review_at = nowIso(new Date(Date.now() + cfg.lifecycle.reviewDays * 86_400_000));
  saveRecord(cfg, record, { event: 'sealed', note: force ? 'forced' : '' });
  return record;
}

export function wakeRecord(cfg, ref, temperature = 'warm') {
  if (!TEMPERATURES.has(temperature)) throw new MemError(`未知温度：${temperature}`, 'BAD_TEMPERATURE');
  return updateRecord(cfg, ref, (meta) => {
    meta.temperature = temperature;
    meta.last_touched_at = nowIso();
    if (meta.review_state === 'reviewed') meta.review_state = 'needs_review';
  }, { event: `wake:${temperature}` });
}

export function supersedeRecord(cfg, oldRef, opts = {}) {
  const old = loadRecord(cfg, oldRef);
  const oldMeta = old.meta;
  if (oldMeta.standing === 'superseded') {
    throw new MemError(`记录已被取代：${oldMeta.id} → ${oldMeta.superseded_by || '?'}`, 'ALREADY_SUPERSEDED');
  }
  const newMetaInput = {
    ...opts,
    kind: opts.kind || oldMeta.kind,
    workspace: oldMeta.workspace,
    scope: oldMeta.scope,
    project: opts.project ?? oldMeta.project,
    tags: [...new Set([...(oldMeta.tags ?? []), ...(opts.tags ?? [])])],
    entities: [...new Set([...(oldMeta.entities ?? []), ...(opts.entities ?? [])])],
    session_refs: opts.session_refs ?? oldMeta.session_refs,
    artifact_refs: opts.artifact_refs ?? oldMeta.artifact_refs,
    evidence_ids: opts.evidence_ids ?? oldMeta.provenance?.evidence_ids,
    relations: [
      ...(opts.relations ?? []),
      { type: 'supersedes', target: oldMeta.id, why: opts.why || 'new conclusion' },
    ],
    owner: opts.owner || 'agent',
    confidence: opts.confidence ?? 0.8,
    review_state: opts.review_state || 'draft',
  };
  if (!newMetaInput.title || !newMetaInput.gist) {
    throw new MemError('取代需要 --title 和 --gist（写清新结论，不复制旧正文）。', 'MISSING_TITLE_OR_GIST');
  }
  const created = createRecord(cfg, newMetaInput);
  oldMeta.standing = 'superseded';
  oldMeta.superseded_by = created.meta.id;
  oldMeta.relations = [
    ...(oldMeta.relations ?? []).filter((relation) => relation.type !== 'superseded_by'),
    { type: 'superseded_by', target: created.meta.id, why: 'superseded by new conclusion' },
  ];
  oldMeta.updated_at = nowIso();
  saveRecord(cfg, old, { event: 'superseded', note: `by ${created.meta.id}` });
  return { old: old.meta, created };
}

export function annotateRecord(cfg, ref, opts = {}) {
  const first = loadRecord(cfg, ref);
  return withFileLock(lockFileFor(first.dir), () => annotateRecordLocked(cfg, ref, opts));
}

function annotateRecordLocked(cfg, ref, { kind = 'annotation', text, evidence = '', by = 'agent' } = {}) {
  if (!text || !String(text).trim()) throw new MemError('缺少 --text。', 'MISSING_TEXT');
  const record = loadRecord(cfg, ref);
  const { meta, dir } = record;
  const entry = {
    at: nowIso(),
    kind,
    text: oneLine(text),
    evidence: oneLine(evidence),
    by,
  };
  meta.corrections = [...(meta.corrections ?? []), entry].slice(-50);
  meta.last_touched_at = entry.at;
  if (kind === 'user_veto') {
    meta.standing = 'contested';
    meta.temperature = 'frozen';
    meta.confidence = Math.min(meta.confidence ?? 0.5, 0.3);
  } else if (kind === 'counter_evidence') {
    meta.confidence = Math.max(0.1, (meta.confidence ?? 0.5) - 0.1);
  }
  saveRecord(cfg, record, { event: `annotate:${kind}`, note: entry.text });
  appendJsonl(path.join(dir, 'audit', 'corrections.jsonl'), entry);
  // The L1 digest is a derived view. Append, never rewrite, so the correction
  // remains visible without erasing what was believed before.
  const digestPath = path.join(dir, meta.paths?.l1 || LAYER_PATHS.l1);
  const digest = fs.existsSync(digestPath) ? fs.readFileSync(digestPath, 'utf8') : '';
  if (digest) {
    writeText(path.join(dir, 'versions', `${dateStamp()}-${Date.now()}-digest-before-${kind}.md`), digest);
  }
  const block = `\n- ${entry.at} [${kind}] ${entry.text}${entry.evidence ? `（证据：${entry.evidence}）` : ''}\n`;
  const nextDigest = digest.includes('## 修正记录')
    ? `${digest.trimEnd()}\n${block}`
    : `${digest.trimEnd()}\n\n## 修正记录\n${block}`;
  writeText(digestPath, nextDigest);
  saveRecord(cfg, record, { event: `annotate-digest:${kind}`, rebuild: false });
  rebuildCatalog(cfg, { reason: `annotate:${meta.id}` });
  try {
    refreshFtsRecord(cfg, compactRecord({ ...meta, _root: cfg.root, _dir: dir }));
  } catch {
    // Derived index failure must not fail the annotation.
  }
  return record;
}

export function linkRecords(cfg, fromRef, type, toRef, { why = '' } = {}) {
  if (!RELATION_INVERSE[type]) throw new MemError(`未知关系类型：${type}`, 'BAD_RELATION');
  if (type === 'supersedes' || type === 'superseded_by') {
    throw new MemError('取代请用 `mem supersede`，不要直接 link。', 'USE_SUPERSEDE');
  }
  const from = loadRecord(cfg, fromRef);
  const to = loadRecord(cfg, toRef);
  if (from.meta.id === to.meta.id) throw new MemError('不能链接自己。', 'SELF_LINK');
  const add = (meta, relationType, target) => {
    if ((meta.relations ?? []).some((relation) =>
      relation.type === relationType && relation.target === target)) return;
    meta.relations = [...(meta.relations ?? []), { type: relationType, target, why }];
  };
  add(from.meta, type, to.meta.id);
  add(to.meta, RELATION_INVERSE[type], from.meta.id);
  from.meta.last_touched_at = nowIso();
  to.meta.last_touched_at = nowIso();
  saveRecord(cfg, from, { event: `link:${type}`, rebuild: false });
  saveRecord(cfg, to, { event: `link:${RELATION_INVERSE[type]}`, rebuild: false });
  rebuildCatalog(cfg, { reason: `link:${from.meta.id}:${to.meta.id}` });
  try {
    refreshFtsRecord(cfg, compactRecord({ ...from.meta, _root: cfg.root, _dir: from.dir }));
    refreshFtsRecord(cfg, compactRecord({ ...to.meta, _root: cfg.root, _dir: to.dir }));
  } catch {
    // Derived index failure must not fail the link.
  }
  return { from: from.meta, to: to.meta };
}

export function touchRecord(cfg, ref, { temperature = null } = {}) {
  return updateRecord(cfg, ref, (meta) => {
    meta.last_touched_at = nowIso();
    if (temperature) meta.temperature = temperature;
  }, { event: 'touched' });
}

export function setDigest(cfg, ref, text) {
  const record = loadRecord(cfg, ref);
  const { meta, dir } = record;
  if (!text || !String(text).trim()) throw new MemError('digest 不能为空。', 'EMPTY_DIGEST');
  if (String(text).length > cfg.budgets.l1MaxChars) {
    throw new MemError(
      `digest 超预算：${String(text).length} > ${cfg.budgets.l1MaxChars} 字符。请压缩到全貌级。`,
      'DIGEST_TOO_LONG',
    );
  }
  const digestPath = path.join(dir, meta.paths?.l1 || LAYER_PATHS.l1);
  const old = fs.existsSync(digestPath) ? fs.readFileSync(digestPath, 'utf8') : '';
  if (old && old !== text) {
    const versionPath = path.join(dir, 'versions', `${dateStamp()}-${Date.now()}-digest.md`);
    writeText(versionPath, old);
  }
  writeText(digestPath, text);
  meta.integrity.digest_sha256 = sha256(fs.readFileSync(digestPath));
  meta.review_state = 'draft';
  meta.last_touched_at = nowIso();
  saveRecord(cfg, record, { event: 'digest-updated' });
  return record;
}

export function setIndex(cfg, ref, index) {
  const record = loadRecord(cfg, ref);
  const { meta, dir } = record;
  if (!index || typeof index !== 'object' || !index.categories) {
    throw new MemError('index 必须是带 categories 的对象。', 'BAD_INDEX');
  }
  const indexPath = path.join(dir, meta.paths?.l2 || LAYER_PATHS.l2);
  const old = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf8') : '';
  if (old) {
    writeText(path.join(dir, 'versions', `${dateStamp()}-${Date.now()}-index.json`), old);
  }
  writeJson(indexPath, index);
  meta.integrity.index_sha256 = sha256(fs.readFileSync(indexPath));
  meta.last_touched_at = nowIso();
  saveRecord(cfg, record, { event: 'index-updated' });
  return record;
}

export function loadLedger(cfg) {
  const file = path.join(cfg.root, 'ledger.json');
  const ledger = readJson(file, { entries: [] });
  return {
    file,
    entries: Array.isArray(ledger.entries) ? ledger.entries : [],
    raw: ledger,
  };
}

export function buildViews(cfg, compactRecords, sessionsIndex = null) {
  const hot = compactRecords
    .filter((item) => ['hot', 'warm'].includes(item.temperature) && item.standing === 'current')
    .sort((a, b) => String(b.last_touched_at).localeCompare(String(a.last_touched_at)));
  const sealed = compactRecords
    .filter((item) => ['sealed', 'frozen'].includes(item.temperature))
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  const inactive = compactRecords
    .filter((item) => ['superseded', 'contested', 'retracted', 'expired'].includes(item.standing))
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));

  const table = (items) => {
    if (items.length === 0) return '_（空）_\n';
    const rows = items.map((item) =>
      `| ${item.temperature} | \`${item.id}\` | ${escapeCell(item.title, 60)} | ${escapeCell(item.gist, 90)} | ${item.updated_at.slice(0, 10)} |`,
    ).join('\n');
    return `| 温度 | id | 标题 | 路由摘要 | 更新 |\n|---|---|---|---|---|\n${rows}\n`;
  };

  writeText(path.join(cfg.viewsDir, 'HOT.md'), `# 活期记忆视图

> 由 \`mem reindex\` 生成。canonical 数据在 \`records/\`，本文件只是视图。
> 活期 = hot/warm 且 standing=current。按 last_touched_at 降序。

- 记录数：${hot.length}
- 生成时间：${nowIso()}

${table(hot)}
`);

  writeText(path.join(cfg.viewsDir, 'ARCHIVE.md'), `# 封存记忆视图

> 封存只是温度变化，不是文件搬运。canonical 路径不变。
> sealed/frozen 按更新时间降序；被取代/争议条目单列。

- 封存数：${sealed.length}
- 生成时间：${nowIso()}

${table(sealed)}

## 已取代 / 争议 / 撤回

${inactive.length ? table(inactive) : '_（空）_\n'}
`);

  const sessionLines = (sessionsIndex?.sessions ?? []).slice(0, 30).map((session) =>
    `| ${escapeCell(session.title || session.id, 50)} | ${escapeCell(session.workspace, 24)} | ${session.turns ?? 0} | ${(session.updated_at || '').slice(0, 10)} | \`${session.id}\` |`,
  ).join('\n');
  writeText(path.join(cfg.viewsDir, 'SESSIONS.md'), `# 会话索引视图

> 会话卡在 \`sessions/\`，全文在 DSH \`~/.dsh/sessions\`。跨项目可用 \`mem session show <id>\`。
> 原生 @ 引用：\`@[标题](dsh-session:<base64url-id>)\`。

| 标题 | 工作区 | 轮次 | 更新 | id |
|---|---|---|---|---|
${sessionLines || '| _（尚未索引）_ | | | | |'}
`);

  const counts = {
    total: compactRecords.length,
    hot: compactRecords.filter((item) => item.temperature === 'hot').length,
    warm: compactRecords.filter((item) => item.temperature === 'warm').length,
    sealed: compactRecords.filter((item) => item.temperature === 'sealed').length,
    frozen: compactRecords.filter((item) => item.temperature === 'frozen').length,
    current: compactRecords.filter((item) => item.standing === 'current').length,
    history: compactRecords.filter((item) => item.standing !== 'current').length,
    sessions: sessionsIndex?.sessions?.length ?? 0,
  };
  writeText(path.join(cfg.viewsDir, 'MAP.md'), `# 记忆地图

- canonical 记录：\`records/YYYY/MM/<id>/\`
- 活期/封存只是 meta.temperature，不是目录搬迁
- 会话卡：\`sessions/<workspace>/\`
- 索引：\`index/catalog.json\`、\`index/sessions.json\`
- 规范说明：\`SYSTEM.md\`
- CLI：\`system/bin/mem.mjs\`

## 计数

| total | hot | warm | sealed | frozen | current | history | sessions |
|---|---|---|---|---|---|---|---|
| ${counts.total} | ${counts.hot} | ${counts.warm} | ${counts.sealed} | ${counts.frozen} | ${counts.current} | ${counts.history} | ${counts.sessions} |

## 固定文件

每个记录目录从创建起就固定包含：

\`\`\`text
meta.json      # L0
digest.md      # L1
index.json     # L2
README.md      # 人类/AI 入口
content/       # L3（transcripts/artifacts/sources/logs/decisions/notes）
audit/         # 审计（events/evidence/corrections/usage）
versions/      # L1/L2 历史版本
\`\`\`

封存不新增、不移动任何文件。
`);
}

export function recordUsage(cfg, id, action, extra = {}) {
  const { dir } = resolveRecord(cfg, id);
  appendJsonl(path.join(dir, 'audit', 'usage.jsonl'), {
    at: nowIso(),
    action,
    ...extra,
  });
}

export function recordStats(cfg) {
  const catalog = loadCatalog(cfg);
  const sessions = readJson(path.join(cfg.indexDir, 'sessions.json'), { sessions: [] });
  const ledger = loadLedger(cfg);
  return {
    records: catalog.records.length,
    hot: catalog.records.filter((item) => item.temperature === 'hot').length,
    warm: catalog.records.filter((item) => item.temperature === 'warm').length,
    sealed: catalog.records.filter((item) => item.temperature === 'sealed').length,
    frozen: catalog.records.filter((item) => item.temperature === 'frozen').length,
    sessions: sessions.sessions?.length ?? 0,
    claims: ledger.entries.length,
    activeClaims: ledger.entries.filter((entry) => entry.status === 'active').length,
  };
}

export function staleHotRecords(cfg, compactRecords) {
  return compactRecords.filter((item) => {
    if (!['hot', 'warm'].includes(item.temperature)) return false;
    if (item.standing !== 'current') return false;
    if (item.open_loops.length > 0) return false;
    return daysSince(item.last_touched_at) > cfg.lifecycle.sealDays;
  });
}
