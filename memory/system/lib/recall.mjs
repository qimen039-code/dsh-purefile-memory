import fs from 'node:fs';
import path from 'node:path';
import {
  MemError,
  daysSince,
  ensureDir,
  flag,
  flagList,
  formatBytes,
  normKey,
  nowIso,
  oneLine,
  queryTerms,
  readJson,
  resolveInside,
  scoreFields,
  sha256,
  truncate,
  uniqueBy,
  writeJson,
} from './util.mjs';
import {
  loadCatalog,
  loadLedger,
  loadRecord,
  readRecordByDir,
  rebuildCatalog,
  resolveRecord,
} from './store.mjs';
import { findSessions, loadSessions, resolveSession, sessionMention } from './sessions.mjs';
import { indexFileFor, isIndexFresh, searchFts } from './fts.mjs';

function workspaceMatches(workspace, target, scope = 'workspace') {
  if (scope === 'global') return true;
  if (!target) return true;
  return normKey(workspace) === normKey(target);
}

function recencyScore(iso, { hotDays = 3, warmDays = 14 } = {}) {
  const days = daysSince(iso);
  if (!Number.isFinite(days)) return 0;
  if (days <= hotDays) return 1.5;
  if (days <= warmDays) return 0.8;
  if (days <= 60) return 0.2;
  return 0;
}

function exactBonus(query, fields) {
  const needle = oneLine(query).toLowerCase();
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

function recordScore(record, query, cfg, workspace) {  if (!query) {
    return {
      score: recencyScore(record.last_touched_at, cfg.lifecycle)
        + (record.temperature === 'hot' ? 2 : record.temperature === 'warm' ? 1 : 0)
        + (record.confidence ?? 0.5),
      reasons: ['recent'],
    };
  }
  const fields = [
    { text: String(record.title ?? '').toLowerCase(), weight: 9 },
    { text: (record.aliases ?? []).join(' ').toLowerCase(), weight: 8 },
    { text: (record.tags ?? []).join(' ').toLowerCase(), weight: 4 },
    { text: (record.entities ?? []).join(' ').toLowerCase(), weight: 4 },
    { text: String(record.gist ?? '').toLowerCase(), weight: 3 },
    { text: (record.key_points ?? []).join(' ').toLowerCase(), weight: 2 },
    { text: (record.open_loops ?? []).map((loop) => loop.question).join(' ').toLowerCase(), weight: 2 },
    { text: (record.decisions ?? []).map((decision) => decision.statement).join(' ').toLowerCase(), weight: 2 },
  ];
  const base = scoreFields(queryTerms(query), fields);
  const bonus = exactBonus(query, fields);
  if (query && base.score === 0 && bonus === 0) return { score: 0, reasons: [] };
  let score = base.score + bonus;
  const coverage = base.strongTotal > 0 ? base.strongHits / base.strongTotal : 1;
  score *= 0.65 + 0.35 * coverage;
  const reasons = [...base.reasons];
  if (record.temperature === 'sealed') { score -= cfg.recall.sealedPenalty; reasons.push('sealed'); }
  if (record.temperature === 'frozen') { score -= cfg.recall.sealedPenalty * 2; reasons.push('frozen'); }
  if (record.temperature === 'hot') score += 1;
  if (record.standing !== 'current') { score -= 6; reasons.push(record.standing); }
  score += (record.confidence ?? 0.5) * 0.8;
  score += recencyScore(record.updated_at, cfg.lifecycle) * 0.5;
  if (workspace && normKey(record.workspace) === normKey(workspace)) {
    score += 1.2;
    reasons.push('same-workspace');
  }
  return { score, reasons };
}

export function scoreRecordForQuery(record, query, cfg, workspace) {
  return recordScore(record, query, cfg, workspace);
}

function sessionScore(session, query) {
  const fields = [
    { text: String(session.title ?? '').toLowerCase(), weight: 8 },
    { text: String(session.gist ?? '').toLowerCase(), weight: 3 },
    { text: (session.key_points ?? []).join(' ').toLowerCase(), weight: 2 },
    { text: (session.tags ?? []).join(' ').toLowerCase(), weight: 2 },
    { text: (session.entities ?? []).join(' ').toLowerCase(), weight: 2 },
  ];
  const base = scoreFields(queryTerms(query), fields);
  const coverage = base.strongTotal > 0 ? base.strongHits / base.strongTotal : 1;
  return {
    score: (base.score * 0.8 + exactBonus(query, fields)) * (0.65 + 0.35 * coverage),
    reasons: base.reasons,
  };
}

function claimScore(entry, query, workspace) {
  const fields = [
    { text: String(entry.title ?? '').toLowerCase(), weight: 9 },
    { text: String(entry.statement ?? '').toLowerCase(), weight: 4 },
    { text: (entry.tags ?? []).join(' ').toLowerCase(), weight: 4 },
    { text: (entry.applies_when ?? []).join(' ').toLowerCase(), weight: 2 },
    { text: String(entry.disconfirmation ?? '').toLowerCase(), weight: 1 },
  ];
  const base = scoreFields(queryTerms(query), fields);
  const bonus = exactBonus(query, fields);
  if (query && base.score === 0 && bonus === 0) return { score: 0, reasons: [] };
  let score = base.score + bonus;
  const coverage = base.strongTotal > 0 ? base.strongHits / base.strongTotal : 1;
  score *= 0.65 + 0.35 * coverage;
  if (workspace && entry.scope === 'workspace') score += 1;
  if (entry.scope === 'global') score += 0.3;
  score += (entry.confidence ?? 0.5);
  return { score, reasons: base.reasons };
}

function claimUsable(entry, workspace, { includeAll = false } = {}) {
  if (!entry || entry.status !== 'active') return false;
  if (!includeAll && entry.scope === 'workspace' && !workspaceMatches(entry.workspace, workspace)) return false;
  if (entry.expires_at && Date.parse(entry.expires_at) <= Date.now()) return false;
  return true;
}

export function recall(cfg, options = {}) {
  const started = Date.now();
  const query = String(options.query ?? '').trim();
  const workspace = options.workspace || cfg.defaultWorkspace;
  const allWorkspaces = Boolean(options.allWorkspaces);
  const history = Boolean(options.history);
  const includeSealed = options.includeSealed !== false;
  const kinds = new Set(options.kinds ?? []);
  const limit = Math.max(1, Math.min(
    cfg.budgets.recallMax,
    Number(options.k) || cfg.budgets.recallDefault,
  ));
  const catalog = options.useIndex === false || !query || !isIndexFresh(cfg)
    ? loadCatalog(cfg)
    : null;
  const sessions = loadSessions(cfg);
  // v2 账本是 ACCF 时代的遗留（candidate/active/disconfirmation/纠偏语义）。
  // 2026-10-29 起默认排除出召回链路（config.recall.includeLedger=true 可显式打开）；
  // 文件本体保留不动（事实原文不改），只是不再作为召回来源。
  const includeLedger = cfg.recall?.includeLedger === true;
  const ledger = includeLedger ? loadLedger(cfg) : { entries: [] };
  const results = [];

  if (catalog === null) {
    const indexed = searchFts(indexFileFor(cfg), query, {
      limit: 100,
      workspace,
      allWorkspaces,
      history,
      includeSealed,
      kinds: kinds.size > 0 ? [...kinds] : null,
      allowSensitive: Boolean(options.allowSensitive),
    });
    for (const row of indexed.results) {
      if (kinds.size && !kinds.has(row.kind)) continue;
      if (!history && row.standing !== 'current') continue;
      if (!includeSealed && ['sealed', 'frozen'].includes(row.temperature)) continue;
      if (row.temperature === 'frozen' && !history) continue;
      if (!allWorkspaces && !workspaceMatches(row.workspace, workspace, row.scope)) continue;
      if (row.sensitive && !options.allowSensitive) continue;
      let record;
      try {
        record = JSON.parse(row.doc_json);
      } catch {
        continue;
      }
      const { score, reasons } = scoreRecordForQuery(record, query, cfg, workspace);
      if (query && score <= 0) continue;
      results.push({
        type: 'record',
        id: record.id,
        title: record.title,
        gist: record.gist,
        kind: record.kind,
        temperature: record.temperature,
        standing: record.standing,
        workspace: record.workspace,
        updated_at: record.updated_at,
        last_touched_at: record.last_touched_at,
        score,
        reasons: [...reasons, 'fts-candidate'],
        dir: record.dir,
        next: `mem route ${record.id} --layer l1`,
      });
    }
  } else {
    for (const record of catalog.records) {
      if (kinds.size && !kinds.has(record.kind)) continue;
      if (!history && record.standing !== 'current') continue;
      if (!includeSealed && ['sealed', 'frozen'].includes(record.temperature)) continue;
      if (record.temperature === 'frozen' && !history) continue;
      if (!allWorkspaces && !workspaceMatches(record.workspace, workspace, record.scope)) continue;
      if (record.privacy?.sensitive && !options.allowSensitive) continue;
      const { score, reasons } = recordScore(record, query, cfg, workspace);
      if (query && score <= 0) continue;
      results.push({
        type: 'record',
        id: record.id,
        title: record.title,
        gist: record.gist,
        kind: record.kind,
        temperature: record.temperature,
        standing: record.standing,
        workspace: record.workspace,
        updated_at: record.updated_at,
        last_touched_at: record.last_touched_at,
        score,
        reasons,
        dir: record.dir,
        next: `mem route ${record.id} --layer l1`,
      });
    }
  }

  for (const session of sessions) {
    if (kinds.size && !kinds.has('session')) continue;
    if (!allWorkspaces && !workspaceMatches(session.workspace, workspace)) continue;
    const { score, reasons } = sessionScore(session, query);
    if (query && score <= 0) continue;
    results.push({
      type: 'session',
      id: session.id,
      title: session.title,
      gist: session.gist,
      kind: 'session',
      temperature: daysSince(session.updated_at) <= cfg.lifecycle.warmDays ? 'warm' : 'sealed',
      standing: 'current',
      workspace: session.workspace,
      updated_at: session.updated_at,
      last_touched_at: session.updated_at,
      score,
      reasons,
      dir: session.transcript.path,
      next: `mem session show ${session.id} --last 5`,
      mention: sessionMention(session),
    });
  }

  for (const entry of ledger.entries) {
    if (kinds.size && !kinds.has(entry.kind)) continue;
    if (!claimUsable(entry, workspace, { includeAll: allWorkspaces || history })) continue;
    const { score, reasons } = claimScore(entry, query, workspace);
    if (query && score <= 0) continue;
    results.push({
      type: 'claim',
      id: entry.id,
      title: entry.title,
      gist: entry.statement,
      kind: entry.kind,
      temperature: 'hot',
      standing: entry.status === 'active' ? 'current' : entry.status,
      workspace: entry.workspace || '(global)',
      updated_at: entry.last_verified_at,
      last_touched_at: entry.last_verified_at,
      score,
      reasons: [...reasons, 'claim-ledger'],
      dir: ledger.file,
      next: `memory_recall ${JSON.stringify(entry.title)}`,
    });
  }

  // A deep pass reads L1 only for the lexical shortlist. This keeps normal
  // recall at catalog speed while allowing an explicit “search the summaries”
  // mode when the L0 card is too terse.
  if (options.deep && query) {
    const shortlist = [...results].sort((a, b) => b.score - a.score).slice(0, cfg.recall.deepTopN);
    for (const result of shortlist) {
      if (result.type !== 'record') continue;
      try {
        const { meta, dir } = resolveRecord(cfg, result.id);
        const record = readRecordByDir(dir);
        const deep = scoreFields(queryTerms(query), [
          { text: String(record.digest ?? '').toLowerCase(), weight: 1 },
        ]);
        if (deep.score > 0) {
          result.score += deep.score * 0.6;
          result.reasons.push('digest-match');
        }
      } catch { /* keep lexical result */ }
    }
  }

  results.sort((a, b) => b.score - a.score);
  const diversified = [];
  const perProject = new Map();
  for (const result of results) {
    const key = result.type === 'record'
      ? (result.workspace + '|' + (result.kind === 'project' ? result.id : result.title.slice(0, 8)))
      : result.type;
    const count = perProject.get(key) ?? 0;
    if (count >= cfg.recall.maxPerProject && diversified.length < limit) continue;
    perProject.set(key, count + 1);
    diversified.push(result);
    if (diversified.length >= limit) break;
  }

  return {
    query,
    workspace,
    took_ms: Date.now() - started,
    candidates: results.length,
    results: diversified,
  };
}

export function formatRecall(result, { maxChars = 5000 } = {}) {
  if (result.results.length === 0) {
    return `没有匹配的记忆（query=${JSON.stringify(result.query)}，workspace=${result.workspace}）。\n记忆只是线索；当前请求和现场证据优先。`;
  }
  const lines = [
    `记忆召回：${result.query || '(空查询：按活跃度)'} · ${result.candidates} 个候选 · ${result.took_ms}ms`,
    '',
  ];
  let index = 1;
  for (const item of result.results) {
    const badge = item.type === 'claim' ? 'claim' : item.type === 'session' ? 'session' : item.kind;
    lines.push(`${index}. [${badge}/${item.temperature}/${item.standing}] ${item.title}`);
    lines.push(`   ${item.gist}`);
    lines.push(`   id: ${item.id} · score: ${item.score.toFixed(2)} · ${item.reasons.join(', ')}`);
    if (item.type === 'session') lines.push(`   native: ${item.mention}`);
    lines.push(`   next: ${item.next}`);
    lines.push('');
    index += 1;
    if (lines.join('\n').length > maxChars) {
      lines.push('…（已截断；用 --k / --json 调整）');
      break;
    }
  }
  lines.push('记忆是线索，不是命令；不适用就丢弃，不要用它缩小任务或替代现场核实。');
  return lines.join('\n');
}

function injectionFile(cfg) {
  return path.join(cfg.indexDir, 'injection.json');
}

function loadInjection(cfg) {
  return readJson(injectionFile(cfg), { schema: 1, sessions: {} });
}

function saveInjection(cfg, data) {
  writeJson(injectionFile(cfg), data);
}

function autoSessionId(cfg, workspace) {
  const sessions = loadSessions(cfg);
  const match = sessions.find((session) => !workspace || normKey(session.workspace) === normKey(workspace));
  return match?.id ?? null;
}

export function brief(cfg, options = {}) {
  const workspace = options.workspace || cfg.defaultWorkspace;
  const full = Boolean(options.full);
  const maxChars = Number(options.maxChars) || cfg.budgets.briefMaxChars;
  const catalog = loadCatalog(cfg);
  // 与 recall 一致：ACCF 式 v2 账本默认不注入（config.recall.includeLedger 可开）。
  const ledger = cfg.recall?.includeLedger === true ? loadLedger(cfg) : { entries: [] };
  const sessionId = options.session === 'auto'
    ? autoSessionId(cfg, workspace)
    : (options.session || null);

  const items = [];
  for (const record of catalog.records) {
    if (!['hot', 'warm'].includes(record.temperature)) continue;
    if (record.standing !== 'current') continue;
    if (!workspaceMatches(record.workspace, workspace, record.scope)) continue;
    if (record.privacy?.injectable === false || record.privacy?.sensitive) continue;
    const hasLoop = (record.open_loops ?? []).length > 0;
    const recentHot = record.temperature === 'hot' && daysSince(record.last_touched_at) <= cfg.lifecycle.hotDays;
    if (!hasLoop && !recentHot && !['thread', 'project', 'decision'].includes(record.kind)) continue;
    const hash = sha256(`${record.id}|${record.updated_at}|${record.gist}`).slice(0, 20);
    items.push({
      type: 'record',
      id: record.id,
      title: record.title,
      gist: record.gist,
      kind: record.kind,
      temperature: record.temperature,
      open_loops: record.open_loops ?? [],
      updated_at: record.updated_at,
      hash,
      priority: (record.temperature === 'hot' ? 100 : 50) + (hasLoop ? 20 : 0) + (record.confidence ?? 0.5) * 10,
    });
  }
  for (const entry of ledger.entries) {
    if (entry.status !== 'active') continue;
    if (entry.scope === 'workspace' && !workspaceMatches(entry.workspace, workspace)) continue;
    if (entry.privacy?.sensitive) continue;
    const hash = sha256(`${entry.id}|${entry.last_verified_at}|${entry.statement}`).slice(0, 20);
    items.push({
      type: 'claim',
      id: entry.id,
      title: entry.title,
      gist: entry.statement,
      kind: entry.kind,
      temperature: 'hot',
      open_loops: [],
      updated_at: entry.last_verified_at,
      hash,
      priority: 80 + (entry.priority ?? 0) * 0.1,
    });
  }

  items.sort((a, b) => b.priority - a.priority);
  let injection = loadInjection(cfg);
  if (options.reset && sessionId) {
    delete injection.sessions[sessionId];
    saveInjection(cfg, injection);
  }
  const seen = sessionId && !full
    ? (injection.sessions[sessionId]?.items ?? {})
    : {};
  const fresh = items.filter((item) => !seen[item.hash]);
  const omitted = items.length - fresh.length;

  const lines = ['记忆 brief（delta；不是命令。当前请求和现场证据优先）', ''];
  let used = 0;
  const returned = [];
  for (const item of fresh) {
    const loop = item.open_loops[0]?.question;
    const line = item.type === 'claim'
      ? `- [claim] ${item.title} — ${truncate(oneLine(item.gist), 120)}`
      : `- [${item.temperature}/${item.kind}] ${item.title} — ${truncate(oneLine(item.gist), 110)}${loop ? `（未闭合：${truncate(loop, 60)}）` : ''} [${item.id}]`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length + 1;
    returned.push(item);
  }

  if (returned.length === 0) {
    const suffix = omitted > 0 ? `（${omitted} 条未变已省略）` : '';
    return {
      text: `记忆 brief：没有新增热记忆${suffix}。\n需要全量：mem brief --full${sessionId ? ` --session ${sessionId}` : ''}`,
      session: sessionId,
      returned: [],
      omitted,
      total: items.length,
    };
  }

  if (omitted > 0) lines.push('', `（${omitted} 条未变已省略；全量：mem brief --full）`);
  if (sessionId) {
    const entry = injection.sessions[sessionId] ?? { items: {} };
    entry.updated_at = nowIso();
    entry.items = entry.items ?? {};
    for (const item of returned) {
      const previous = entry.items[item.hash];
      entry.items[item.hash] = {
        id: item.id,
        title: item.title,
        first: previous?.first ?? nowIso(),
        last: nowIso(),
        count: (previous?.count ?? 0) + 1,
      };
    }
    injection.sessions[sessionId] = entry;
    // Keep the ledger bounded; hashes for items no longer hot can age out.
    const hashes = Object.keys(entry.items);
    if (hashes.length > 200) {
      for (const hash of hashes.slice(0, hashes.length - 200)) delete entry.items[hash];
    }
    saveInjection(cfg, injection);
  }
  return {
    text: lines.join('\n'),
    session: sessionId,
    returned: returned.map((item) => ({ type: item.type, id: item.id, title: item.title, hash: item.hash })),
    omitted,
    total: items.length,
  };
}

function collectIndexPaths(index, dir, category) {
  const categories = index?.categories ?? {};
  const names = category ? [category] : Object.keys(categories);
  const paths = [];
  for (const name of names) {
    for (const entry of categories[name] ?? []) {
      const value = entry?.path || entry?.snapshot_path || (name === 'sources' ? entry?.url : '');
      if (!value) continue;
      if (/^[a-z]+:\/\//i.test(value)) {
        paths.push(value);
        continue;
      }
      paths.push(path.isAbsolute(value) ? value : path.resolve(dir, value));
    }
  }
  return [...new Set(paths)];
}

function collectFiles(dir) {
  const out = [];
  const visit = (current) => {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else out.push(full);
    }
  };
  visit(dir);
  return out;
}

export function route(cfg, ref, options = {}) {
  let targetRef = ref;
  let uriLayer = null;
  let uriCategory = null;
  let uriFile = null;
  if (String(ref).startsWith('mem://')) {
    let parsed;
    try { parsed = new URL(String(ref)); } catch {
      throw new MemError(`无效的记忆 URI：${ref}`, 'BAD_URI');
    }
    targetRef = parsed.hostname;
    const parts = parsed.pathname.split('/').filter(Boolean);
    uriLayer = parts.shift() ?? 'l1';
    uriCategory = parts.shift() ?? null;
    uriFile = parts.join('/') || null;
  }
  let record;
  try {
    record = loadRecord(cfg, targetRef);
  } catch (error) {
    if (error.code !== 'RECORD_NOT_FOUND') throw error;
    const found = recall(cfg, { query: targetRef, k: 3, workspace: options.workspace || cfg.defaultWorkspace });
    if (found.results.length === 0) throw error;
    const top = found.results[0];
    if (top.type === 'session') {
      return { query: targetRef, redirected: true, type: 'session', id: top.id, next: top.next };
    }
    if (top.type === 'claim') {
      return { query: targetRef, redirected: true, type: 'claim', id: top.id, next: top.next };
    }
    record = loadRecord(cfg, top.id);
  }
  const { meta, dir, digest, index } = record;
  const layer = String(options.layer || uriLayer || 'l1').toLowerCase();
  const category = options.category ? String(options.category) : uriCategory;
  const file = options.file ? String(options.file) : uriFile;
  let target = dir;
  let content = null;
  let payload = null;

  if (layer === 'l0' || layer === 'meta') {
    target = path.join(dir, 'meta.json');
    content = meta;
  } else if (layer === 'l1' || layer === 'digest') {
    target = path.join(dir, meta.paths?.l1 || 'digest.md');
    content = digest;
  } else if (layer === 'readme') {
    target = path.join(dir, 'README.md');
    content = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  } else if (layer === 'l2' || layer === 'index') {
    target = path.join(dir, meta.paths?.l2 || 'index.json');
    if (category) {
      const categories = index?.categories ?? {};
      if (!(category in categories)) {
        throw new MemError(`index 没有分类：${category}（可用：${Object.keys(categories).join(', ')}）`, 'NO_CATEGORY');
      }
      payload = categories[category];
      content = payload;
    } else {
      content = index;
    }
  } else if (layer === 'l3' || layer === 'content') {
    const base = path.join(dir, meta.paths?.l3 || 'content');
    target = category ? resolveInside(base, category) : base;
    if (!fs.existsSync(target)) {
      throw new MemError(`内容路径不存在：${target}`, 'NO_CONTENT');
    }
    if (file) {
      target = resolveInside(target, file);
      if (!fs.existsSync(target)) throw new MemError(`文件不存在：${target}`, 'NO_FILE');
      content = fs.readFileSync(target, 'utf8');
    } else {
      payload = fs.readdirSync(target, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? 'dir' : 'file',
        bytes: entry.isFile() ? fs.statSync(path.join(target, entry.name)).size : null,
      }));
      content = payload;
    }
  } else if (layer === 'audit') {
    target = path.join(dir, meta.paths?.audit || 'audit');
    if (file) target = resolveInside(target, file);
    if (fs.existsSync(target) && fs.statSync(target).isFile()) content = fs.readFileSync(target, 'utf8');
  } else {
    throw new MemError(`未知层：${layer}（可用 l0/l1/l2/l3/audit/readme）`, 'BAD_LAYER');
  }

  return {
    id: meta.id,
    title: meta.title,
    layer,
    path: target,
    relative: path.relative(cfg.root, target).split(path.sep).join('/'),
    content,
    payload,
    paths: options.paths
      ? (layer === 'l2' || layer === 'index'
        ? collectIndexPaths(index, dir, category)
        : layer === 'l3' || layer === 'content'
          ? (fs.existsSync(target) ? (fs.statSync(target).isDirectory() ? collectFiles(target) : [target]) : [])
          : (fs.existsSync(target) && fs.statSync(target).isFile() ? [target] : []))
      : undefined,
    meta: layer === 'l0' || options.withMeta ? meta : undefined,
    next: layer === 'l1' ? `mem route ${meta.id} --layer l2 --category artifacts` : undefined,
  };
}

export function formatRoute(result, { open = false } = {}) {
  if (result.type === 'session' || result.type === 'claim') {
    return `已重定向到 ${result.type}：${result.id}\nnext: ${result.next}`;
  }
  const lines = [
    `# ${result.title}`,
    `id: ${result.id}`,
    `layer: ${result.layer}`,
    `path: ${result.path}`,
  ];
  if (result.next) lines.push(`next: ${result.next}`);
  if (open && result.content !== null && result.content !== undefined) {
    lines.push('', '---', '');
    if (typeof result.content === 'string') lines.push(result.content);
    else lines.push(JSON.stringify(result.content, null, 2));
  }
  return lines.join('\n');
}
