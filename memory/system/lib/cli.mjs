import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MemError,
  boolFlag,
  ensureDir,
  findZstd,
  flag,
  flagList,
  formatBytes,
  isoDay,
  newId,
  normKey,
  nowIso,
  numberFlag,
  oneLine,
  pad,
  parseArgs,
  readJson,
  sha256,
  truncate,
  workspaceKey,
  writeJson,
} from './util.mjs';
import {
  annotateRecord,
  createRecord,
  digestTemplate,
  indexTemplate,
  linkRecords,
  loadCatalog,
  loadConfig,
  loadLedger,
  loadRecord,
  readMeta,
  rebuildCatalog,
  resolveRecord,
  saveRecord,
  scanRecordDirs,
  sealRecord,
  setDigest,
  setIndex,
  staleHotRecords,
  supersedeRecord,
  touchRecord,
  updateRecord,
  wakeRecord,
} from './store.mjs';
import {
  buildFtsIndex,
  indexFileFor,
  isIndexFresh,
} from './fts.mjs';
import { similarRecords } from './related.mjs';
import {
  candidateGistFromSession,
  createCandidate,
  dropCandidate,
  listCandidates,
  loadCandidate,
  promoteCandidate,
  updateCandidate,
} from './inbox.mjs';
import { createView, listViews, loadView, pruneViews } from './view.mjs';
import {
  findSessions,
  indexSessions,
  loadSessions,
  resolveSession,
  scanSessionDirs,
  sessionContext,
  sessionMention,
  sessionStats,
  showSession,
} from './sessions.mjs';
import { brief, formatRecall, formatRoute, recall, route } from './recall.mjs';
import {
  analyzeQuery,
  factScore,
  formatFactLine,
  loadFactsFromDir,
} from './facts.mjs';

const HELP = `mem — DSH 分层活期/封存记忆系统

用法：
  mem <command> [options]

读取：
  recall <query>            召回 L0 卡、会话卡、账本 claim、事实层（--no-facts 关闭；
                            --no-semantic 关闭语义重排；--dialog <id> 限定对话记录）
  facts <id> [query]        列出/检索某记录的事实层
  check <query>             写前查重/相似记录（只读；--title/--gist 也可）
  inbox list|add|show|update|promote|drop
                            候选记忆暂存；promote 才写 canonical
  view [query]|list|show|prune
                            把一次 recall 快照成只读 view
  brief                     热记忆 delta（默认去重；--full 全量）
  route <id>                按层跳转：--layer l0|l1|l2|l3|audit|readme
                            --paths 只输出该层/分类的可读文件路径（接官方 read/grep）
  show <id>                 显示 L0 + 导航
  chain <id>                显示 supersedes / superseded_by 结论链
  list                      列出记录
  session list|show|context|find|link|index|stats
  stats                     计数
  doctor                    校验
  config                    路径/预算

写入（显式；不自动）：
  ingest-dialog             摄入多会话对话 JSON → episode 记录 + 事实层
                            （--file 必需；--no-llm 词面兜底；--force 重抽取）
  new                       新建记录（可 --from-session）
  digest <id>               写 L1（--file/--text/--stdin）
  index-set <id>            写 L2（--file）
  update <id>               改标题/标签/未闭合/决策等
  seal <id>                 封存（要求 L1 足够、无未闭合；--force）
  wake <id>                 唤醒（--hot/--warm）
  touch <id>                更新 last_touched
  supersede <old>           新结论=新记录，旧记录保留并标 superseded
  annotate <id>             追加修正/反证/否决（不改旧正文）
  link <a> <type> <b>       类型化双向链接

维护：
  reindex [--sessions]      重建 catalog/sessions/views（并重建检索索引）
  index-build               只重建 FTS5 检索索引
  sweep                     列出可封存/待复核
  selftest                  临时目录端到端自测

通用：
  --json                    机器输出
  --workspace <path>        指定工作区
  --config <file>           指定 config.json

例：
  mem recall "ACCF 隔离" --k 5
  mem route rec-20261026-181500-a1b2 --layer l2 --category artifacts --open
  mem session show 441ffb80 --last 3
  mem brief --session auto
  mem supersede rec-... --title "新结论" --gist "一句话新结论"
`;

function out(text) {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

function jsonOut(value) {
  out(JSON.stringify(value, null, 2));
}

function inputText(flags) {
  if (flags.text !== undefined) return String(flags.text);
  if (flags.file) return fs.readFileSync(String(flags.file), 'utf8');
  if (flags.stdin) return fs.readFileSync(0, 'utf8');
  return null;
}

function requirePositional(positionals, index, name) {
  const value = positionals[index];
  if (!value) throw new MemError(`缺少参数：${name}`, 'MISSING_ARG');
  return value;
}

function loadCfg(flags) {
  return loadConfig({
    configPath: flags.config ? String(flags.config) : undefined,
    root: flags.root ? String(flags.root) : undefined,
    sessionsRoot: flags['sessions-root'] ? String(flags['sessions-root']) : undefined,
    projectionRoot: flags['projection-root'] ? String(flags['projection-root']) : undefined,
  });
}

function printRecord(record, { json = false } = {}) {
  if (json) {
    jsonOut({
      id: record.meta.id,
      dir: record.dir,
      meta: record.meta,
      digest_chars: String(record.digest).trim().length,
      paths: {
        l0: path.join(record.dir, 'meta.json'),
        l1: path.join(record.dir, record.meta.paths?.l1 || 'digest.md'),
        l2: path.join(record.dir, record.meta.paths?.l2 || 'index.json'),
        l3: path.join(record.dir, record.meta.paths?.l3 || 'content'),
        audit: path.join(record.dir, record.meta.paths?.audit || 'audit'),
      },
    });
    return;
  }
  const meta = record.meta;
  out(`# ${meta.title}`);
  out('');
  out(`> ${meta.gist}`);
  out('');
  out(`- id: ${meta.id}`);
  out(`- kind: ${meta.kind} · temperature: ${meta.temperature} · standing: ${meta.standing}`);
  out(`- workspace: ${meta.workspace || '(global)'} · project: ${meta.project || '(none)'}`);
  out(`- created: ${meta.created_at} · updated: ${meta.updated_at}`);
  out(`- review: ${meta.review_state} · confidence: ${meta.confidence}`);
  out(`- dir: ${record.dir}`);
  out(`- digest: ${String(record.digest).trim().length} chars`);
  if (meta.open_loops?.length) {
    out('');
    out('线索：');
    for (const loop of meta.open_loops) out(`- [${loop.status}] ${loop.question}`);
  }
  out('');
  out('next:');
  out(`  mem route ${meta.id} --layer l1 --open`);
  out(`  mem route ${meta.id} --layer l2 --category artifacts`);
}

function printList(items, { json = false } = {}) {
  if (json) {
    jsonOut(items);
    return;
  }
  if (items.length === 0) {
    out('（没有记录）');
    return;
  }
  const lines = ['| id | kind | temp | standing | title | updated |', '|---|---|---|---|---|---|'];
  for (const item of items) {
    lines.push(`| \`${item.id}\` | ${item.kind} | ${item.temperature} | ${item.standing} | ${String(item.title).replace(/\|/g, '\\|')} | ${(item.updated_at || '').slice(0, 10)} |`);
  }
  out(lines.join('\n'));
}

function cmdNew(cfg, flags) {
  let fromSession = null;
  if (flags['from-session']) {
    fromSession = resolveSession(cfg, String(flags['from-session']));
  }
  const title = flag(flags, 'title', fromSession?.title);
  const gist = flag(flags, 'gist', fromSession?.gist);
  if (!title) throw new MemError('new 需要 --title（或用 --from-session）。', 'MISSING_TITLE');
  if (!boolFlag(flags, 'force', false)) {
    const duplicate = loadCatalog(cfg).records.find((item) =>
      item.standing === 'current' && oneLine(item.title).toLowerCase() === oneLine(title).toLowerCase());
    if (duplicate) {
      throw new MemError(
        `已有同标题 current 记录：${duplicate.id}。要改结论用 mem supersede；确实要另起一条用 --force。`,
        'DUPLICATE_TITLE',
      );
    }
  }
  const digestFile = flags['digest-file'] ? String(flags['digest-file']) : null;
  const body = flags.body ? String(flags.body) : fromSession
    ? `来源会话：\`${fromSession.id}\`（${fromSession.workspace}）\n\n${fromSession.gist}\n`
    : '';
  const sessionRefs = fromSession
    ? [{
      id: fromSession.id,
      workspace: fromSession.workspace,
      turns: [],
      captured_at: nowIso(),
      note: 'created from session card',
    }]
    : flagList(flags, 'session').map((id) => ({ id, workspace: String(flag(flags, 'workspace', cfg.defaultWorkspace)) }));
  const opts = {
    title,
    gist,
    kind: flag(flags, 'kind', 'episode'),
    workspace: flag(flags, 'workspace', fromSession?.workspace || cfg.defaultWorkspace),
    project: flag(flags, 'project', ''),
    scope: boolFlag(flags, 'global', false) ? 'global' : 'workspace',
    tags: [...new Set([...(fromSession?.tags ?? []), ...flagList(flags, 'tags')])],
    entities: flagList(flags, 'entities'),
    aliases: flagList(flags, 'aliases'),
    key_points: [...new Set([...(fromSession?.key_points ?? []).slice(0, 5), ...flagList(flags, 'key')])],
    open_loops: flagList(flags, 'open'),
    session_refs: sessionRefs,
    body,
    confidence: numberFlag(flags, 'confidence', 0.7),
    owner: flag(flags, 'owner', 'agent'),
    temperature: flag(flags, 'temperature', 'hot'),
    disconfirmation: flag(flags, 'disconfirmation', undefined),
    sensitive: boolFlag(flags, 'sensitive', false),
  };
  if (digestFile) opts.digest = fs.readFileSync(digestFile, 'utf8');
  const { meta, dir } = createRecord(cfg, opts);
  if (boolFlag(flags, 'json', false)) {
    jsonOut({ id: meta.id, dir, meta });
  } else {
    out(`created ${meta.id}`);
    out(`path: ${dir}`);
    out(`next: mem digest ${meta.id} --file <summary.md>`);
    out(`      mem seal ${meta.id}`);
  }
}

function cmdDigest(cfg, positionals, flags) {
  const id = requirePositional(positionals, 0, 'id');
  const text = inputText(flags);
  if (text === null) {
    const record = loadRecord(cfg, id);
    out(record.digest);
    return;
  }
  const record = setDigest(cfg, id, text);
  if (boolFlag(flags, 'json', false)) jsonOut({ id: record.meta.id, digest_chars: String(record.digest).trim().length });
  else out(`digest updated: ${record.meta.id} (${String(record.digest).trim().length} chars)`);
}

function cmdIndexSet(cfg, positionals, flags) {
  const id = requirePositional(positionals, 0, 'id');
  if (!flags.file) throw new MemError('index-set 需要 --file <index.json>。', 'MISSING_FILE');
  const index = readJson(String(flags.file));
  const record = setIndex(cfg, id, index);
  if (boolFlag(flags, 'json', false)) jsonOut({ id: record.meta.id, index: record.index });
  else out(`index updated: ${record.meta.id}`);
}

function cmdUpdate(cfg, positionals, flags) {
  const id = requirePositional(positionals, 0, 'id');
  const record = updateRecord(cfg, id, (meta) => {
    if (flags.title !== undefined) meta.title = oneLine(flags.title);
    if (flags.gist !== undefined) meta.gist = oneLine(flags.gist);
    if (flags.project !== undefined) meta.project = oneLine(flags.project);
    if (flags.confidence !== undefined) meta.confidence = Number(flags.confidence);
    if (flags.disconfirmation !== undefined) meta.disconfirmation = oneLine(flags.disconfirmation);
    if (flags['review-state'] !== undefined) meta.review_state = String(flags['review-state']);
    if (flags.temperature !== undefined) meta.temperature = String(flags.temperature);
    if (flags.standing !== undefined) {
      if (['superseded'].includes(String(flags.standing))) {
        throw new MemError('改 standing=superseded 请用 `mem supersede`。', 'USE_SUPERSEDE');
      }
      meta.standing = String(flags.standing);
    }
    for (const tag of flagList(flags, 'tags-add')) {
      if (!meta.tags.includes(tag)) meta.tags.push(tag);
    }
    for (const tag of flagList(flags, 'tags-remove')) {
      meta.tags = meta.tags.filter((item) => item !== tag);
    }
    for (const entity of flagList(flags, 'entities-add')) {
      if (!meta.entities.includes(entity)) meta.entities.push(entity);
    }
    for (const alias of flagList(flags, 'aliases-add')) {
      if (!meta.aliases.includes(alias)) meta.aliases.push(alias);
    }
    for (const key of flagList(flags, 'key')) {
      if (!meta.key_points.includes(key)) meta.key_points.push(key);
    }
    if (boolFlag(flags, 'clear-keys', false)) meta.key_points = [];
    for (const question of flagList(flags, 'open')) {
      meta.open_loops.push({
        id: `loop-${sha256(question).slice(0, 8)}`,
        question,
        status: 'unresolved',
        next_action: '',
        owner: '',
      });
    }
    const closeValues = flagList(flags, 'close-loop');
    if (closeValues.length > 0) {
      for (const loop of meta.open_loops) {
        if (closeValues.some((value) => loop.id === value || loop.question.includes(value))) {
          loop.status = 'resolved';
        }
      }
    }
    for (const sid of flagList(flags, 'session')) {
      const id = sid.startsWith('session-') ? sid : `session-${sid}`;
      if (!meta.session_refs.some((ref) => ref.id === id)) {
        meta.session_refs.push({ id, workspace: meta.workspace || cfg.defaultWorkspace, turns: [], captured_at: nowIso(), note: '' });
      }
    }
    for (const statement of flagList(flags, 'decision')) {
      meta.decisions.push({
        id: `dec-${sha256(statement).slice(0, 8)}`,
        statement,
        status: 'in-force',
        reason: '',
        alternatives: [],
        evidence: [],
        confidence: 0.7,
      });
    }
    if (boolFlag(flags, 'reviewed', false)) meta.review_state = 'reviewed';
    meta.last_touched_at = nowIso();
  }, { event: 'update' });
  if (boolFlag(flags, 'json', false)) printRecord(record, { json: true });
  else printRecord(record);
}

function cmdSeal(cfg, positionals, flags) {
  const id = requirePositional(positionals, 0, 'id');
  const record = sealRecord(cfg, id, { force: boolFlag(flags, 'force', false) });
  if (boolFlag(flags, 'json', false)) jsonOut({ id: record.meta.id, temperature: record.meta.temperature });
  else out(`sealed ${record.meta.id}（文件未移动；temperature=${record.meta.temperature}）`);
}

function cmdWake(cfg, positionals, flags) {
  const id = requirePositional(positionals, 0, 'id');
  const temperature = boolFlag(flags, 'hot', false) ? 'hot' : 'warm';
  const record = wakeRecord(cfg, id, temperature);
  if (boolFlag(flags, 'json', false)) jsonOut({ id: record.meta.id, temperature: record.meta.temperature });
  else out(`woke ${record.meta.id} → ${record.meta.temperature}`);
}

function cmdTouch(cfg, positionals, flags) {
  const id = requirePositional(positionals, 0, 'id');
  const record = touchRecord(cfg, id, { temperature: boolFlag(flags, 'hot', false) ? 'hot' : null });
  if (boolFlag(flags, 'json', false)) jsonOut({ id: record.meta.id, last_touched_at: record.meta.last_touched_at });
  else out(`touched ${record.meta.id}`);
}

function cmdSupersede(cfg, positionals, flags) {
  const old = requirePositional(positionals, 0, 'old');
  const digestFile = flags['digest-file'] ? String(flags['digest-file']) : null;
  const created = supersedeRecord(cfg, old, {
    title: flag(flags, 'title', undefined),
    gist: flag(flags, 'gist', undefined),
    kind: flag(flags, 'kind', undefined),
    digest: digestFile ? fs.readFileSync(digestFile, 'utf8') : undefined,
    body: flag(flags, 'body', ''),
    why: flag(flags, 'why', ''),
    tags: flagList(flags, 'tags'),
    entities: flagList(flags, 'entities'),
    confidence: numberFlag(flags, 'confidence', 0.8),
  });
  if (boolFlag(flags, 'json', false)) {
    jsonOut({ old: created.old, new: created.created.meta });
  } else {
    out(`superseded ${created.old.id}`);
    out(`new: ${created.created.meta.id}`);
    out(`path: ${created.created.dir}`);
    out(`next: mem digest ${created.created.meta.id} --file <new-conclusion.md>`);
  }
}

function cmdAnnotate(cfg, positionals, flags) {
  const id = requirePositional(positionals, 0, 'id');
  const text = inputText(flags);
  if (text === null) throw new MemError('annotate 需要 --text/--file/--stdin。', 'MISSING_TEXT');
  const record = annotateRecord(cfg, id, {
    kind: boolFlag(flags, 'veto', false) ? 'user_veto' : String(flag(flags, 'kind', 'annotation')),
    text,
    evidence: flag(flags, 'evidence', ''),
    by: flag(flags, 'by', 'agent'),
  });
  if (boolFlag(flags, 'json', false)) printRecord(record, { json: true });
  else out(`annotated ${record.meta.id}（旧正文未改；digest 追加修正记录）`);
}

function cmdLink(cfg, positionals, flags) {
  const from = requirePositional(positionals, 0, 'from');
  const type = requirePositional(positionals, 1, 'type');
  const to = requirePositional(positionals, 2, 'to');
  const result = linkRecords(cfg, from, type, to, { why: flag(flags, 'why', '') });
  if (boolFlag(flags, 'json', false)) jsonOut({ from: result.from, to: result.to });
  else out(`linked ${result.from.id} --${type}--> ${result.to.id}`);
}

function cmdShow(cfg, positionals, flags) {
  const id = requirePositional(positionals, 0, 'id');
  printRecord(loadRecord(cfg, id), { json: boolFlag(flags, 'json', false) });
}

function cmdChain(cfg, positionals, flags) {
  const id = requirePositional(positionals, 0, 'id');
  const seen = new Set();
  const chain = [];
  const add = (record) => {
    if (seen.has(record.meta.id)) return;
    seen.add(record.meta.id);
    chain.push(record);
  };
  let current = loadRecord(cfg, id);
  add(current);
  while (current) {
    const previous = (current.meta.relations ?? []).find((relation) => relation.type === 'supersedes');
    if (!previous) break;
    try {
      current = loadRecord(cfg, previous.target);
      add(current);
    } catch {
      break;
    }
  }
  current = loadRecord(cfg, id);
  while (current.meta.superseded_by) {
    try {
      current = loadRecord(cfg, current.meta.superseded_by);
      add(current);
    } catch {
      break;
    }
  }
  chain.sort((a, b) => String(a.meta.created_at).localeCompare(String(b.meta.created_at)));
  if (boolFlag(flags, 'json', false)) {
    jsonOut(chain.map((record) => ({
      id: record.meta.id,
      title: record.meta.title,
      standing: record.meta.standing,
      temperature: record.meta.temperature,
      created_at: record.meta.created_at,
      superseded_by: record.meta.superseded_by ?? null,
      corrections: record.meta.corrections?.length ?? 0,
    })));
    return;
  }
  out(`# 结论链：${chain[0]?.meta.title ?? id}`);
  out('');
  for (const [index, record] of chain.entries()) {
    out(`${index + 1}. [${record.meta.standing}/${record.meta.temperature}] ${record.meta.title}`);
    out(`   ${record.meta.id} · ${record.meta.created_at.slice(0, 10)} · corrections ${record.meta.corrections?.length ?? 0}`);
    out(`   ${record.meta.gist}`);
    if (record.meta.superseded_by) out(`   → ${record.meta.superseded_by}`);
  }
  out('');
  out('next: mem route <id> --layer audit --file corrections.jsonl');
}

function cmdList(cfg, flags) {
  const catalog = loadCatalog(cfg);
  const temperatures = new Set(flagList(flags, 'temperature'));
  const standings = new Set(flagList(flags, 'standing'));
  const kinds = new Set(flagList(flags, 'kind'));
  const workspace = flag(flags, 'workspace', null);
  const limit = numberFlag(flags, 'limit', 100);
  let items = catalog.records;
  if (temperatures.size) items = items.filter((item) => temperatures.has(item.temperature));
  if (standings.size) items = items.filter((item) => standings.has(item.standing));
  if (kinds.size) items = items.filter((item) => kinds.has(item.kind));
  if (workspace) items = items.filter((item) => item.scope === 'global'
    || normKey(item.workspace) === normKey(workspace));
  items = items.slice(0, limit);
  printList(items, { json: boolFlag(flags, 'json', false) });
}

async function cmdRecall(cfg, positionals, flags) {
  const query = positionals.join(' ').trim();
  const kinds = flagList(flags, 'kind');
  const result = recall(cfg, {
    query,
    workspace: flag(flags, 'workspace', cfg.defaultWorkspace),
    allWorkspaces: boolFlag(flags, 'all-workspaces', false),
    includeSealed: boolFlag(flags, 'include-sealed', true) && !boolFlag(flags, 'no-sealed', false),
    history: boolFlag(flags, 'history', false),
    kinds,
    k: numberFlag(flags, 'k', cfg.budgets.recallDefault),
    deep: boolFlag(flags, 'deep', false),
    allowSensitive: boolFlag(flags, 'allow-sensitive', false),
  });
  // 事实层召回（v3.1）：默认开启；--no-facts 关闭；语义重排跟随 config.semantic。
  let factsResult = null;
  if (!boolFlag(flags, 'no-facts', false) && query) {
    try {
      const { recallFacts } = await import('./facts.mjs');
      factsResult = await recallFacts(cfg, {
        query,
        k: numberFlag(flags, 'k', cfg.budgets.recallDefault),
        semantic: !boolFlag(flags, 'no-semantic', false),
        dialogId: flag(flags, 'dialog', null),
      });
    } catch (error) {
      if (!boolFlag(flags, 'json', false)) {
        process.stderr.write(`[facts] 召回失败，忽略事实层：${error.message}\n`);
      }
    }
  }
  if (boolFlag(flags, 'json', false)) {
    jsonOut({ ...result, facts: factsResult });
    return;
  }
  const lines = [formatRecall(result)];
  if (factsResult) {
    lines.push('', `事实层（${factsResult.semantic ? '词面+语义' : '词面'} · ${factsResult.candidates} 候选 · ${factsResult.took_ms}ms）`);
    if (factsResult.items.length === 0) {
      lines.push(factsResult.abstained ? '  （无足够相关事实，建议明确说“不知道”）' : '  （无匹配事实）');
    } else {
      factsResult.items.forEach((item, index) => {
        const rr = item.rerank === null || item.rerank === undefined ? '' : ` · rerank=${item.rerank}`;
        lines.push(`${index + 1}. ${item.snippet}`);
        lines.push(`   id: ${item.id} · record: ${item.record_id}${rr}`);
      });
    }
  }
  out(lines.join('\n'));
}

function cmdCheck(cfg, positionals, flags) {
  const query = positionals.join(' ').trim();
  const title = String(flag(flags, 'title', '') || '');
  const gist = String(flag(flags, 'gist', '') || '');
  if (!query && !title && !gist) {
    throw new MemError('check 需要查询词，或 --title/--gist。', 'MISSING_QUERY');
  }
  const result = similarRecords(cfg, {
    query,
    title,
    gist,
    k: numberFlag(flags, 'k', 5),
    minCoverage: numberFlag(flags, 'min-coverage', 0.3),
    excludeId: flag(flags, 'exclude', null),
    allWorkspaces: boolFlag(flags, 'all-workspaces', false),
    workspace: flag(flags, 'workspace', cfg.defaultWorkspace),
  });
  if (boolFlag(flags, 'json', false)) {
    jsonOut(result);
    return;
  }
  if (!result.available) {
    out(`无法查重：${result.reason}。先运行 mem index-build。`);
    return;
  }
  if (result.results.length === 0) {
    out('没有相似记录。');
    return;
  }
  out(`相似记录（只读；不自动改）：${result.results.length} 条`);
  for (const item of result.results) {
    out(`${item.rank}. [${item.kind}/${item.temperature}] ${item.title} — ${oneLine(item.gist)}`);
    out(`   id: ${item.id} · coverage ${item.coverage} · next: ${item.next}`);
  }
}

function cmdView(cfg, positionals, flags) {
  const sub = positionals[0] || 'list';
  const json = boolFlag(flags, 'json', false);
  if (sub === 'list') {
    const views = listViews(cfg);
    if (json) {
      jsonOut(views.map((view) => ({ id: view.id, query: view.query, created_at: view.created_at, results: view.results.length })));
      return;
    }
    if (views.length === 0) {
      out('view: 空');
      return;
    }
    for (const view of views) out(`${view.id} · ${view.query} · ${view.results.length} results · ${view.created_at}`);
    return;
  }
  if (sub === 'show') {
    const id = requirePositional(positionals, 1, 'view id 或 latest');
    const view = loadView(cfg, id);
    if (json) jsonOut(view);
    else out(JSON.stringify(view, null, 2));
    return;
  }
  if (sub === 'prune') {
    const removed = pruneViews(cfg, numberFlag(flags, 'keep', 50));
    if (json) jsonOut({ removed });
    else out(`pruned ${removed} view(s)`);
    return;
  }

  const query = positionals.join(' ').trim();
  if (!query) throw new MemError('view 需要查询词，或 list/show/prune。', 'MISSING_QUERY');
  const workspace = flag(flags, 'workspace', cfg.defaultWorkspace);
  const result = recall(cfg, {
    query,
    k: numberFlag(flags, 'k', 5),
    workspace,
    session: flag(flags, 'session', ''),
  });
  const text = formatRecall(result);
  const view = createView(cfg, {
    query,
    workspace,
    session: flag(flags, 'session', ''),
    result,
    text,
  });
  if (json) jsonOut({ id: view.id, results: view.results, created_at: view.created_at });
  else {
    out(`view: ${view.id}`);
    out(`results: ${view.results.length}`);
    out(`next: mem view show ${view.id}`);
  }
}

function cmdInbox(cfg, positionals, flags) {
  const sub = positionals[0] || 'list';
  const json = boolFlag(flags, 'json', false);
  if (sub === 'list') {
    const items = listCandidates(cfg);
    if (json) {
      jsonOut(items);
      return;
    }
    if (items.length === 0) {
      out('inbox: 空');
      return;
    }
    for (const item of items) out(`${item.id} · ${item.title} — ${oneLine(item.gist)}`);
    return;
  }
  if (sub === 'add') {
    let session = null;
    if (flags['from-session']) session = resolveSession(cfg, String(flags['from-session']));
    const title = flag(flags, 'title', session?.title);
    const gist = flag(flags, 'gist', session ? candidateGistFromSession(session) : undefined);
    if (!title || !gist) throw new MemError('inbox add 需要 --title 和 --gist（或 --from-session）。', 'MISSING_TITLE');
    const candidate = createCandidate(cfg, {
      title,
      gist,
      kind: String(flag(flags, 'kind', 'episode')),
      temperature: String(flag(flags, 'temperature', 'warm')),
      keyPoints: [...new Set([...(session?.key_points ?? []).slice(0, 5), ...flagList(flags, 'key')])],
      tags: [...new Set([...(session?.tags ?? []), ...flagList(flags, 'tags')])],
      body: flag(flags, 'body', session ? `来源会话：\`${session.id}\`\n\n${gist}` : ''),
      source: flag(flags, 'source', session ? `session:${session.id}` : ''),
      sessionRefs: session ? [{ id: session.id, workspace: session.workspace, note: 'inbox candidate' }] : [],
      workspace: flag(flags, 'workspace', session?.workspace || cfg.defaultWorkspace),
    });
    if (json) jsonOut(candidate);
    else {
      out(`candidate: ${candidate.id}`);
      out(`next: mem inbox promote ${candidate.id}`);
    }
    return;
  }
  if (sub === 'show') {
    const id = requirePositional(positionals, 1, 'candidate id');
    const candidate = loadCandidate(cfg, id);
    if (json) jsonOut(candidate);
    else out(JSON.stringify(candidate, null, 2));
    return;
  }
  if (sub === 'update') {
    const id = requirePositional(positionals, 1, 'candidate id');
    const patch = {};
    if (flags.title !== undefined) patch.title = String(flag(flags, 'title'));
    if (flags.gist !== undefined) patch.gist = String(flag(flags, 'gist'));
    if (flags.body !== undefined) patch.body = String(flag(flags, 'body'));
    if (flags.kind !== undefined) patch.kind = String(flag(flags, 'kind'));
    if (flags.temperature !== undefined) patch.temperature = String(flag(flags, 'temperature'));
    if (flags.workspace !== undefined) patch.workspace = String(flag(flags, 'workspace'));
    if (flags.key !== undefined) patch.key_points = flagList(flags, 'key');
    if (flags.tags !== undefined) patch.tags = flagList(flags, 'tags');
    if (Object.keys(patch).length === 0) throw new MemError('inbox update 需要至少一个字段。', 'MISSING_FIELD');
    const candidate = updateCandidate(cfg, id, patch);
    if (json) jsonOut(candidate);
    else out(`updated ${candidate.id}`);
    return;
  }
  if (sub === 'promote') {
    const id = requirePositional(positionals, 1, 'candidate id');
    const result = promoteCandidate(cfg, id, { force: boolFlag(flags, 'force', false) });
    if (json) jsonOut({ id: result.created.meta.id, dir: result.created.dir, candidate: result.candidate.id });
    else {
      out(`promoted ${result.created.meta.id}`);
      out(`path: ${result.created.dir}`);
    }
    return;
  }
  if (sub === 'drop') {
    const id = requirePositional(positionals, 1, 'candidate id');
    const candidate = dropCandidate(cfg, id);
    if (json) jsonOut({ dropped: candidate.id });
    else out(`dropped ${candidate.id}`);
    return;
  }
  throw new MemError(`未知 inbox 子命令：${sub}`, 'BAD_SUBCOMMAND');
}

function cmdBrief(cfg, flags) {
  const result = brief(cfg, {
    workspace: flag(flags, 'workspace', cfg.defaultWorkspace),
    session: flags.session === undefined ? null : String(flags.session),
    full: boolFlag(flags, 'full', false),
    reset: boolFlag(flags, 'reset', false),
    maxChars: numberFlag(flags, 'max-chars', cfg.budgets.briefMaxChars),
  });
  if (boolFlag(flags, 'json', false)) jsonOut(result);
  else out(result.text);
}

function cmdRoute(cfg, positionals, flags) {
  const ref = positionals.join(' ').trim();
  if (!ref) throw new MemError('route 需要记录 id 或查询。', 'MISSING_REF');
  const result = route(cfg, ref, {
    layer: flags.layer !== undefined ? String(flags.layer) : undefined,
    category: flags.category,
    file: flags.file,
    workspace: flag(flags, 'workspace', cfg.defaultWorkspace),
    withMeta: boolFlag(flags, 'with-meta', false),
    paths: boolFlag(flags, 'paths', false),
  });
  if (boolFlag(flags, 'paths', false)) {
    if (!result.paths || result.paths.length === 0) {
      throw new MemError('该层没有可解析的文件路径。', 'NO_PATHS');
    }
    for (const item of result.paths) out(item);
    return;
  }
  if (boolFlag(flags, 'path', false)) {
    out(result.path ?? result.next ?? '');
    return;
  }
  if (boolFlag(flags, 'json', false)) {
    jsonOut(result);
    return;
  }
  out(formatRoute(result, { open: boolFlag(flags, 'open', false) }));
}

function cmdSession(cfg, positionals, flags) {
  const sub = positionals[0] || 'list';
  const json = boolFlag(flags, 'json', false);
  if (sub === 'index') {
    const result = indexSessions(cfg, { force: boolFlag(flags, 'force', false) });
    const index = buildFtsIndex(loadCatalog(cfg).records, indexFileFor(cfg), {
      catalogPath: path.join(cfg.indexDir, 'catalog.json'),
    });
    if (json) jsonOut({ sessions: result.cards.length, errors: result.errors, index: index.records });
    else out(`indexed ${result.cards.length} sessions（errors ${result.errors.length}），index=${index.records}`);
    return;
  }
  if (sub === 'list') {
    let sessions = loadSessions(cfg);
    const workspace = flag(flags, 'workspace', null);
    const query = flag(flags, 'query', positionals[1] || null);
    if (workspace) sessions = sessions.filter((session) =>
      normKey(session.workspace) === normKey(workspace));
    if (query) {
      sessions = findSessions(cfg, query, { k: numberFlag(flags, 'k', 20), workspace })
        .map((item) => item.session);
    } else {
      sessions = sessions.slice(0, numberFlag(flags, 'limit', 30));
    }
    if (json) jsonOut(sessions);
    else {
      out('| id | 标题 | 工作区 | 轮次 | 更新 |');
      out('|---|---|---|---|---|');
      for (const session of sessions) {
        out(`| \`${session.id}\` | ${String(session.title).replace(/\|/g, '\\|')} | ${session.workspace} | ${session.turns} | ${(session.updated_at || '').slice(0, 10)} |`);
      }
    }
    return;
  }
  if (sub === 'show') {
    const id = requirePositional(positionals, 1, 'session id');
    const result = showSession(cfg, id, { ...flags, json });
    if (json) jsonOut(result);
    else out(result);
    return;
  }
  if (sub === 'context') {
    const id = requirePositional(positionals, 1, 'session id');
    out(sessionContext(cfg, id, { last: numberFlag(flags, 'last', 3) }));
    return;
  }
  if (sub === 'find') {
    const query = positionals.slice(1).join(' ').trim();
    if (!query) throw new MemError('session find 需要查询词。', 'MISSING_QUERY');
    const results = findSessions(cfg, query, {
      k: numberFlag(flags, 'k', 8),
      workspace: flag(flags, 'workspace', null),
    });
    if (json) jsonOut(results);
    else {
      for (const [index, item] of results.entries()) {
        out(`${index + 1}. ${item.session.title} — ${item.session.gist}`);
        out(`   id: ${item.session.id} · ${item.session.workspace} · score ${item.score.toFixed(2)}`);
        out(`   next: mem session show ${item.session.id} --last 5`);
      }
      if (results.length === 0) out('没有匹配的会话。');
    }
    return;
  }
  if (sub === 'link') {
    const id = requirePositional(positionals, 1, 'session id');
    const session = resolveSession(cfg, id);
    if (json) jsonOut({ id: session.id, mention: sessionMention(session) });
    else out(sessionMention(session));
    return;
  }
  if (sub === 'stats') {
    const stats = sessionStats(cfg);
    if (json) jsonOut(stats);
    else out(JSON.stringify(stats, null, 2));
    return;
  }
  throw new MemError(`未知 session 子命令：${sub}`, 'BAD_SUBCOMMAND');
}

function cmdIndexBuild(cfg, flags) {
  const catalog = loadCatalog(cfg);
  const result = buildFtsIndex(catalog.records, indexFileFor(cfg), {
    catalogPath: path.join(cfg.indexDir, 'catalog.json'),
  });
  if (boolFlag(flags, 'json', false)) jsonOut(result);
  else out(`index built: records=${result.records} in ${result.build_ms.toFixed(1)}ms`);
}

function cmdReindex(cfg, flags) {
  const catalog = rebuildCatalog(cfg, { reason: 'reindex' });
  if (boolFlag(flags, 'sessions', false)) {
    const sessions = indexSessions(cfg, { force: true });
    const index = buildFtsIndex(loadCatalog(cfg).records, indexFileFor(cfg), {
      catalogPath: path.join(cfg.indexDir, 'catalog.json'),
    });
    if (boolFlag(flags, 'json', false)) jsonOut({ records: catalog.records.length, sessions: sessions.cards.length, index: index.records });
    else out(`reindexed records=${catalog.records.length} sessions=${sessions.cards.length} index=${index.records}`);
    return;
  }
  const index = buildFtsIndex(catalog.records, indexFileFor(cfg), {
    catalogPath: path.join(cfg.indexDir, 'catalog.json'),
  });
  if (boolFlag(flags, 'json', false)) jsonOut({ records: catalog.records.length, index: index.records });
  else out(`reindexed records=${catalog.records.length} index=${index.records}`);
}

function cmdStats(cfg, flags) {
  const catalog = loadCatalog(cfg);
  const sessions = loadSessions(cfg);
  const ledger = loadLedger(cfg);
  const stats = {
    records: catalog.records.length,
    hot: catalog.records.filter((item) => item.temperature === 'hot').length,
    warm: catalog.records.filter((item) => item.temperature === 'warm').length,
    sealed: catalog.records.filter((item) => item.temperature === 'sealed').length,
    frozen: catalog.records.filter((item) => item.temperature === 'frozen').length,
    current: catalog.records.filter((item) => item.standing === 'current').length,
    sessions: sessions.length,
    claims: ledger.entries.length,
    active_claims: ledger.entries.filter((entry) => entry.status === 'active').length,
  };
  if (boolFlag(flags, 'json', false)) jsonOut(stats);
  else {
    out(`records: ${stats.records}（hot ${stats.hot} / warm ${stats.warm} / sealed ${stats.sealed} / frozen ${stats.frozen}）`);
    out(`current: ${stats.current}`);
    out(`sessions: ${stats.sessions}`);
    out(`claims: ${stats.claims}（active ${stats.active_claims}）`);
    out(`root: ${cfg.root}`);
  }
}

function cmdConfig(cfg, flags) {
  const zstd = findZstd(cfg);
  const result = {
    root: cfg.root,
    recordsRoot: cfg.recordsRoot,
    sessionsStore: cfg.sessionsStore,
    indexDir: cfg.indexDir,
    viewsDir: cfg.viewsDir,
    sessionsRoot: cfg.sessionsRoot,
    projectionRoot: cfg.projectionRoot,
    defaultWorkspace: cfg.defaultWorkspace,
    zstd,
    budgets: cfg.budgets,
    lifecycle: cfg.lifecycle,
  };
  if (boolFlag(flags, 'json', false)) jsonOut(result);
  else out(JSON.stringify(result, null, 2));
}

function cmdDoctor(cfg, flags) {
  const errors = [];
  const warnings = [];
  const catalog = loadCatalog(cfg);
  const dirs = scanRecordDirs(cfg);
  if (dirs.length !== catalog.records.length) {
    warnings.push(`catalog 记录数 ${catalog.records.length} 与磁盘 ${dirs.length} 不一致；运行 mem reindex。`);
  }
  if (fs.existsSync(indexFileFor(cfg)) && !isIndexFresh(cfg)) {
    warnings.push('FTS 检索索引已过期；运行 mem index-build（过期时自动回退基线检索）。');
  }
  const loaded = [];
  const ids = new Map();
  for (const item of catalog.records) {
    ids.set(item.id, item);
    const dir = path.resolve(cfg.root, item.dir);
    try {
      const meta = readMeta(dir);
      const digest = fs.readFileSync(path.join(dir, meta.paths?.l1 || 'digest.md'), 'utf8');
      const indexRaw = fs.readFileSync(path.join(dir, meta.paths?.l2 || 'index.json'), 'utf8');
      const index = JSON.parse(indexRaw);
      if (meta.integrity?.digest_sha256 && sha256(digest) !== meta.integrity.digest_sha256) {
        errors.push(`${item.id}: digest 完整性 hash 不匹配`);
      }
      if (meta.integrity?.index_sha256 && sha256(indexRaw) !== meta.integrity.index_sha256) {
        errors.push(`${item.id}: index 完整性 hash 不匹配`);
      }
      loaded.push({ item, dir, meta, digest, index });
    } catch (error) {
      errors.push(`${item.id}: 读取失败 ${error.message}`);
    }
  }
  for (const entry of loaded) {
    const { item, dir, meta, digest, index } = entry;
    const required = ['schema', 'id', 'kind', 'title', 'gist', 'workspace', 'scope', 'owner', 'standing',
      'temperature', 'created_at', 'updated_at', 'last_touched_at', 'paths'];
    for (const key of required) {
      if (meta[key] === undefined || meta[key] === null || meta[key] === '') {
        errors.push(`${item.id}: 缺少字段 ${key}`);
      }
    }
    if (meta.id !== item.id) errors.push(`${item.id}: meta.id 不一致 (${meta.id})`);
    if (meta.id !== path.basename(dir)) errors.push(`${item.id}: 目录名与 id 不一致 (${path.basename(dir)})`);
    if (oneLine(meta.gist).length > cfg.budgets.gistMax) {
      warnings.push(`${item.id}: gist ${oneLine(meta.gist).length} 字符超过预算 ${cfg.budgets.gistMax}`);
    }
    const digestChars = String(digest).trim().length;
    if (digestChars === 0) errors.push(`${item.id}: digest 为空`);
    if (digestChars > cfg.budgets.l1MaxChars) {
      warnings.push(`${item.id}: digest ${digestChars} 字符超过预算 ${cfg.budgets.l1MaxChars}`);
    }
    if (meta.temperature === 'sealed' && digestChars < cfg.lifecycle.sealMinDigestChars) {
      errors.push(`${item.id}: sealed 但 digest 仅 ${digestChars} 字符`);
    }
    if (meta.temperature === 'sealed' && (meta.open_loops ?? []).some((loop) => loop.status === 'unresolved')) {
      warnings.push(`${item.id}: sealed 但仍有未闭合问题`);
    }
    if (['hot', 'warm'].includes(meta.temperature) && meta.standing === 'current'
      && (meta.open_loops ?? []).every((loop) => loop.status !== 'unresolved')
      && Date.now() - Date.parse(meta.last_touched_at) > cfg.lifecycle.sealDays * 86_400_000) {
      warnings.push(`${item.id}: 可能可封存（超过 ${cfg.lifecycle.sealDays} 天未触碰且无未闭合）`);
    }
    if (meta.review_at && Date.parse(meta.review_at) < Date.now()) {
      warnings.push(`${item.id}: review 已到期 (${meta.review_at})`);
    }
    if (meta.standing === 'superseded') {
      if (!meta.superseded_by) errors.push(`${item.id}: superseded 但缺少 superseded_by`);
      else if (!ids.has(meta.superseded_by)) warnings.push(`${item.id}: superseded_by 目标不存在 ${meta.superseded_by}`);
    }
    if (index && !index.categories) {
      errors.push(`${item.id}: index.json 缺少 categories`);
    }
    if (index?.record_id && index.record_id !== meta.id) {
      errors.push(`${item.id}: index.record_id 不一致 (${index.record_id})`);
    }
    const checkPointer = (value, label) => {
      if (!value || /^[a-z]+:\/\//i.test(value)) return;
      const full = path.isAbsolute(value) ? value : path.resolve(dir, value);
      if (!fs.existsSync(full)) warnings.push(`${item.id}: L2 ${label} 指向不存在的路径 ${value}`);
    };
    const categories = index?.categories ?? {};
    for (const entry of categories.artifacts ?? []) checkPointer(entry.path, 'artifact');
    for (const entry of categories.logs ?? []) checkPointer(entry.path, 'log');
    for (const entry of categories.sessions ?? []) checkPointer(entry.path, 'session');
    for (const entry of categories.sources ?? []) checkPointer(entry.snapshot_path, 'source-snapshot');
    for (const entry of categories.notes ?? []) checkPointer(entry.path, 'note');
  }
  // Relations live in both directions; validate after every record id is known.
  for (const { item, meta } of loaded) {
    for (const relation of meta.relations ?? []) {
      if (!ids.has(relation.target) && !String(relation.target).startsWith('session-')) {
        warnings.push(`${item.id}: 关系目标不存在 ${relation.type} -> ${relation.target}`);
      }
    }
  }
  // supersede chains must be bidirectional.
  for (const item of catalog.records) {
    if (!item.superseded_by) continue;
    const other = ids.get(item.superseded_by);
    if (!other) continue;
    const back = readJson(path.join(cfg.root, other.dir, 'meta.json'), null);
    if (!back) continue;
    if (!(back.relations ?? []).some((relation) =>
      relation.type === 'supersedes' && relation.target === item.id)) {
      warnings.push(`${item.id}: ${item.superseded_by} 未回链 supersedes`);
    }
  }
  const sessionDirs = scanSessionDirs(cfg);
  const sessionIndex = readJson(path.join(cfg.indexDir, 'sessions.json'), { sessions: [] });
  if ((sessionIndex.sessions ?? []).length !== sessionDirs.length) {
    warnings.push(`session 索引 ${(sessionIndex.sessions ?? []).length} 与磁盘 ${sessionDirs.length} 不一致；运行 mem session index。`);
  }
  for (const session of sessionIndex.sessions ?? []) {
    if (!fs.existsSync(session.transcript.path)) {
      errors.push(`session ${session.id}: transcript 不存在`);
    }
  }
  const ledger = loadLedger(cfg);
  const activeClaims = ledger.entries.filter((entry) => entry.status === 'active');
  if (activeClaims.length > 20) warnings.push(`active claims ${activeClaims.length} > 20（记忆规则预算）`);
  const claimIds = new Set();
  for (const entry of ledger.entries) {
    if (claimIds.has(entry.id)) errors.push(`claim id 重复：${entry.id}`);
    claimIds.add(entry.id);
    if (entry.status === 'active' && (!entry.disconfirmation || !entry.evidence?.length)) {
      errors.push(`claim ${entry.id}: active 但缺 disconfirmation/evidence`);
    }
  }
  if (!findZstd(cfg)) errors.push('找不到 zstd；会话全文读取不可用。');
  const profilePatch = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');
  if (fs.existsSync(profilePatch)) {
    const patch = fs.readFileSync(profilePatch, 'utf8');
    if (!/id:\s*session-reference/.test(patch)) {
      warnings.push('desktop profile patch 未显式启用 session-reference；@ 会话可能 pending。');
    }
    if (!/excludedDirectories:[\s\S]*\bmemory\b/.test(patch)) {
      warnings.push('desktop profile patch 未把 memory 从 @ 文件候选中排除；可能出现会话卡重复。');
    }
  }
  const ledgerPlugin = 'D:/DSH/plugins/dsh-memory-ledger/lib/index.js';
  if (fs.existsSync(ledgerPlugin) && !fs.readFileSync(ledgerPlugin, 'utf8').includes('applyVaultTools')) {
    warnings.push('dsh-memory-ledger 尚未桥接 vault 工具；mem_* 不会注册。');
  }
  const result = { errors, warnings, counts: { records: catalog.records.length, dirs: dirs.length, sessions: sessionDirs.length } };
  if (boolFlag(flags, 'json', false)) jsonOut(result);
  else {
    out(`doctor: ${errors.length} error(s), ${warnings.length} warning(s)`);
    out(`records ${catalog.records.length} / dirs ${dirs.length} / sessions ${sessionDirs.length}`);
    for (const error of errors) out(`ERROR ${error}`);
    for (const warning of warnings) out(`WARN  ${warning}`);
  }
  if (errors.length > 0) process.exitCode = 1;
}

function cmdSweep(cfg, flags) {
  const catalog = loadCatalog(cfg);
  const stale = staleHotRecords(cfg, catalog.records);
  const review = catalog.records.filter((item) => item.review_at && Date.parse(item.review_at) < Date.now());
  const noDigest = catalog.records.filter((item) => item.review_state !== 'reviewed');
  const result = { stale, review, noDigest };
  if (boolFlag(flags, 'json', false)) {
    jsonOut({
      stale: stale.map((item) => ({ id: item.id, title: item.title, last_touched_at: item.last_touched_at })),
      review: review.map((item) => ({ id: item.id, title: item.title, review_at: item.review_at })),
      noDigest: noDigest.map((item) => ({ id: item.id, title: item.title, review_state: item.review_state })),
    });
    return;
  }
  out(`可封存候选：${stale.length}`);
  for (const item of stale) out(`- ${item.id} ${item.title}（last ${item.last_touched_at.slice(0, 10)}）→ mem seal ${item.id}`);
  out(`待复核：${review.length}`);
  for (const item of review) out(`- ${item.id} ${item.title}（review ${item.review_at.slice(0, 10)}）`);
  out(`未 reviewed：${noDigest.length}`);
  for (const item of noDigest) out(`- ${item.id} ${item.title}（${item.review_state}）`);
}

// 每轮要点落盘（机器循环入口）：逐字全存、永不截断；
// 只跳过与上一条完全相同的冗余内容（语义无损——唯一允许的去重形式）。
function cmdTurn(cfg, flags) {
  const note = String(flag(flags, 'note', '') || flag(flags, 'text', '') || positionals.join(' ') || '');
  if (!note.trim()) throw new MemError('turn 需要 --note "本轮要点"', 'MISSING_NOTE');
  const session = String(flag(flags, 'session', 'default') || 'default');
  const now = new Date();
  const day = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const dir = path.join(cfg.root, 'turns');
  ensureDir(dir);
  const file = path.join(dir, `${day}.jsonl`);
  // 逐字保存（仅去除首尾空白，不改内容、不截断）。
  const entry = {
    ts: now.toISOString(),
    session,
    note: note.replace(/^\s+|\s+$/g, ''),
  };
  const dedup = sha256(entry.session + '|' + entry.note).slice(0, 10);
  let last = null;
  if (fs.existsSync(file)) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
    if (lines.length) last = JSON.parse(lines[lines.length - 1]);
  }
  // 仅完全相同的冗余内容跳过（同会话 + 逐字相同）；任何语义差异都完整保留。
  if (last && last.dedup === dedup) {
    if (boolFlag(flags, 'json', false)) jsonOut({ ok: true, dedup: 'exact-duplicate-skipped' });
    else out('与上一条逐字相同（完全冗余），跳过；任何有差异的内容都会完整保存。');
    return;
  }
  fs.appendFileSync(file, JSON.stringify({ ...entry, dedup }) + '\n', 'utf8');
  const msg = `turn 已逐字记录：${file}（${session}，${entry.note.length} 字）`;
  if (boolFlag(flags, 'json', false)) jsonOut({ ok: true, file, dedup });
  else out(msg);
}

// 大结果落盘（stow）：把大工具输出/文件存为 reference 记录，回执只含 id+gist 指针。
function cmdStow(cfg, flags) {
  const file = String(flag(flags, 'file', '') || positionals[0] || '');
  if (!file || !fs.existsSync(file)) throw new MemError(`stow 需要 --file <存在的文件>`, 'MISSING_FILE');
  const title = oneLine(flag(flags, 'title', '') || path.basename(file));
  const bytes = fs.statSync(file).size;
  const content = fs.readFileSync(file, 'utf8');
  const head = truncate(oneLine(content), cfg.budgets.gistMax);
  const { meta, dir } = createRecord(cfg, {
    title: truncate(`Stow：${title}`, cfg.budgets.titleMax),
    gist: truncate(head, cfg.budgets.gistMax),
    kind: 'reference',
    temperature: 'warm',
    tags: ['stow'],
    key_points: [`${bytes} bytes · ${content.split(/\r?\n/).length} 行`, `原文完整保留于本记录 content/artifacts/`],
    created_by: 'mem-stow',
  });
  const artifactName = path.basename(file);
  const dest = path.join(dir, 'content', 'artifacts', artifactName);
  ensureDir(path.dirname(dest));
  fs.copyFileSync(file, dest);
  const idx = indexTemplate(meta);
  idx.categories.artifacts.push({
    path: `content/artifacts/${artifactName}`,
    kind: 'stowed-output',
    bytes,
    summary: head,
  });
  setIndex(cfg, meta.id, idx);
  const msg = `stow 完成：${meta.id}（指针=gist，原文可 route ${meta.id} --layer l3 --category artifacts 回读）`;
  if (boolFlag(flags, 'json', false)) jsonOut({ ok: true, id: meta.id, gist: head, bytes });
  else out(msg);
}

async function cmdIngestDialog(cfg, flags) {
  const file = String(flag(flags, 'file', '') || '');
  if (!file) throw new MemError('ingest-dialog 需要 --file <dialog.json>', 'MISSING_FILE');
  const { ingestDialogFromFile } = await import('./dialog.mjs');
  const result = await ingestDialogFromFile(cfg, file, {
    id: flag(flags, 'id', null),
    workspace: flag(flags, 'workspace', cfg.defaultWorkspace),
    noLlm: boolFlag(flags, 'no-llm', false),
    force: boolFlag(flags, 'force', false),
  });
  const payload = {
    ok: true,
    record_id: result.id,
    facts: result.facts,
    reused: result.reused,
    extraction: result.extraction || null,
    dir: result.dir,
  };
  if (boolFlag(flags, 'json', false)) jsonOut(payload);
  else out(`已摄入 ${result.id}：${result.facts} 条事实（${result.reused ? '复用缓存' : result.extraction || 'fallback'}）`);
}

function cmdFacts(cfg, positionals, flags) {
  const ref = requirePositional(positionals, 0, '记录 id');
  const { dir } = resolveRecord(cfg, ref);
  const facts = loadFactsFromDir(dir);
  const query = positionals.slice(1).join(' ').trim();
  let items = facts;
  if (query) {
    const analysis = analyzeQuery(query);
    items = facts
      .map((fact) => ({ fact, score: factScore(fact, analysis).score }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((item) => item.fact);
  }
  const limit = numberFlag(flags, 'limit', 20);
  const shown = items.slice(0, limit);
  if (boolFlag(flags, 'json', false)) {
    jsonOut({ record: ref, total: facts.length, matched: items.length, facts: shown });
    return;
  }
  out(`记录 ${ref}：共 ${facts.length} 条事实${query ? `，匹配 ${items.length} 条` : ''}`);
  shown.forEach((fact, index) => {
    out(`${index + 1}. ${formatFactLine(fact)}`);
  });
}

function cmdSelftest(cfg, flags) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem-selftest-'));
  const testCfg = loadConfig({
    configPath: cfg.configPath,
    root: temp,
    sessionsRoot: path.join(temp, 'sessions'),
    projectionRoot: path.join(temp, 'projection'),
  });
  const results = [];
  const assert = (condition, message) => {
    if (!condition) throw new Error(`selftest failed: ${message}`);
    results.push(message);
  };
  try {
    const body = '## 背景与目标\n\n自测记录。\n\n## 结论\n\n' + '这是一段足够长的摘要，用于验证封存门槛。'.repeat(20);
    const created = createRecord(testCfg, {
      title: '自测记忆',
      gist: '用于验证创建、召回、路由、封存、取代、修正与去重注入。',
      tags: ['selftest', 'memory'],
      key_points: ['创建', '封存', '取代'],
      digest: `# 自测记忆\n\n> 自测\n\n${body}`,
      open_loops: [],
      body: '',
    });
    assert(fs.existsSync(path.join(created.dir, 'meta.json')), 'record created');
    const recalled = recall(testCfg, { query: '自测记忆', k: 5 });
    assert(recalled.results.some((item) => item.id === created.meta.id), 'recall finds record');
    const routed = route(testCfg, created.meta.id, { layer: 'l1', open: true });
    assert(String(routed.content).includes('自测记录'), 'route l1 returns digest');
    const sealed = sealRecord(testCfg, created.meta.id, { force: false });
    assert(sealed.meta.temperature === 'sealed', 'seal changes temperature without moving files');
    const replaced = supersedeRecord(testCfg, created.meta.id, {
      title: '自测记忆 v2',
      gist: '新结论取代旧结论，旧记录保留。',
      digest: `# 自测记忆 v2\n\n> 新结论\n\n${body}`,
    });
    assert(replaced.old.standing === 'superseded', 'old record marked superseded');
    assert(replaced.old.superseded_by === replaced.created.meta.id, 'superseded_by points to new');
    const after = recall(testCfg, { query: '自测记忆', k: 5 });
    assert(after.results.every((item) => item.id !== created.meta.id), 'default recall hides superseded');
    const annotated = annotateRecord(testCfg, replaced.created.meta.id, {
      kind: 'correction',
      text: '补充：旧结论的边界是仅限自测。',
    });
    assert(annotated.meta.corrections.length === 1, 'annotation appended');
    const firstBrief = brief(testCfg, { session: 'selftest-session', workspace: testCfg.defaultWorkspace });
    const secondBrief = brief(testCfg, { session: 'selftest-session', workspace: testCfg.defaultWorkspace });
    assert(secondBrief.text.includes('没有新增') || secondBrief.omitted > 0, 'brief dedup works');
    const vetoed = annotateRecord(testCfg, replaced.created.meta.id, {
      kind: 'user_veto',
      text: '用户否决这条结论，不再作为当前事实。',
    });
    assert(vetoed.meta.standing === 'contested', 'user veto marks contested');
    assert(vetoed.meta.temperature === 'frozen', 'user veto freezes the record');
    const afterVeto = recall(testCfg, { query: '自测记忆', k: 5 });
    assert(afterVeto.results.every((item) => item.id !== replaced.created.meta.id), 'contested record is not recalled by default');
    const vetoBrief = brief(testCfg, { session: 'veto-session', workspace: testCfg.defaultWorkspace });
    assert(!vetoBrief.returned.some((item) => item.id === replaced.created.meta.id), 'contested record is not injected');
    const reopened = wakeRecord(testCfg, replaced.created.meta.id, 'hot');
    assert(reopened.meta.temperature === 'hot' && reopened.meta.standing === 'contested', 'wake keeps standing');
    // session indexing on an empty root should not throw
    const indexed = indexSessions(testCfg, { force: true });
    assert(Array.isArray(indexed.cards), 'session index runs');
    const mention = sessionMention({ id: 'session-test', title: '测试会话' });
    const encoded = /dsh-session:([A-Za-z0-9_-]+)/.exec(mention)?.[1];
    assert(encoded && Buffer.from(encoded, 'base64url').toString('utf8') === 'session-test', 'native session mention round-trips');
    if (boolFlag(flags, 'json', false)) jsonOut({ ok: true, results, brief: firstBrief.text });
    else out(`selftest: ${results.length} checks passed`);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

export async function main(argv = process.argv.slice(2)) {
  const { command, flags, positionals } = parseArgs(argv);
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    out(HELP);
    return;
  }
  const json = boolFlag(flags, 'json', false);
  try {
    const cfg = loadCfg(flags);
    switch (command) {
      case 'new': cmdNew(cfg, flags); break;
      case 'digest': cmdDigest(cfg, positionals, flags); break;
      case 'index-set': cmdIndexSet(cfg, positionals, flags); break;
      case 'update': cmdUpdate(cfg, positionals, flags); break;
      case 'seal': cmdSeal(cfg, positionals, flags); break;
      case 'wake': cmdWake(cfg, positionals, flags); break;
      case 'touch': cmdTouch(cfg, positionals, flags); break;
      case 'supersede': cmdSupersede(cfg, positionals, flags); break;
      case 'annotate': cmdAnnotate(cfg, positionals, flags); break;
      case 'link': cmdLink(cfg, positionals, flags); break;
      case 'show': cmdShow(cfg, positionals, flags); break;
      case 'chain': cmdChain(cfg, positionals, flags); break;
      case 'list': cmdList(cfg, flags); break;
      case 'recall': await cmdRecall(cfg, positionals, flags); break;
      case 'ingest-dialog': await cmdIngestDialog(cfg, flags); break;
      case 'facts': cmdFacts(cfg, positionals, flags); break;
      case 'turn': cmdTurn(cfg, flags); break;
      case 'stow': cmdStow(cfg, flags); break;
      case 'check': cmdCheck(cfg, positionals, flags); break;
      case 'inbox': cmdInbox(cfg, positionals, flags); break;
      case 'view': cmdView(cfg, positionals, flags); break;
      case 'brief': cmdBrief(cfg, flags); break;
      case 'route': cmdRoute(cfg, positionals, flags); break;
      case 'session': cmdSession(cfg, positionals, flags); break;
      case 'reindex': cmdReindex(cfg, flags); break;
      case 'index-build': cmdIndexBuild(cfg, flags); break;
      case 'doctor': cmdDoctor(cfg, flags); break;
      case 'sweep': cmdSweep(cfg, flags); break;
      case 'stats': cmdStats(cfg, flags); break;
      case 'config': cmdConfig(cfg, flags); break;
      case 'selftest': cmdSelftest(cfg, flags); break;
      case 'id': out(newId('rec')); break;
      default:
        throw new MemError(`未知命令：${command}\n\n${HELP}`, 'BAD_COMMAND');
    }
  } catch (error) {
    const code = error.code || 'MEM_ERROR';
    if (json) {
      jsonOut({ ok: false, code, message: error.message, detail: error.detail ?? null });
    } else {
      process.stderr.write(`ERROR [${code}] ${error.message}\n`);
      if (error.detail) process.stderr.write(`${JSON.stringify(error.detail, null, 2)}\n`);
    }
    process.exitCode = 1;
  }
}
