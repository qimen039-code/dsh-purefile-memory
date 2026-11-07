import fs from 'node:fs';
import path from 'node:path';
import { loadCatalog, resolveRecord } from './store.mjs';
import {
  MemError,
  ensureDir,
  normKey,
  oneLine,
  sha256,
  truncate,
} from './util.mjs';

// ---------------------------------------------------------------------------
// 事实层（fact layer）
//
// 设计动因（2026-10-28 LoCoMo 审计）：
//   1. 问题虚词（what/did/when）污染词面匹配 —— 引入停用词表 + 内容词抽取。
//   2. 说话人名没有锚定到话语 —— 事实条目带 speakers/entities 字段并加权。
//   3. 无时间锚定 —— 事实带 date_iso/date_text，时间类问题可答。
//   4. 原始轮次直接 top-k 召回噪声大 —— 事实是自包含原子陈述。
//
// 存储：canonical = 记录目录 content/facts/facts.jsonl（半原始材料，L3 邻接层）；
//       派生 = 内存缓存（按文件 mtime 失效）。记录数量级 ~1e4、事实 ~1e6 内全扫足够。
// ---------------------------------------------------------------------------

export const FACTS_SCHEMA = 1;

// 英文功能词：在问题里高频、对定位事实无区分度。
const EN_STOPWORDS = new Set((
  'a an the and or but if then than that this these those there here ' +
  'what when where who whom whose why how which ' +
  'i me my we our you your he him his she her it its they them their ' +
  'am is are was were be been being do does did done doing have has had having ' +
  'will would shall should can could may might must ' +
  'of in on at to for from with without by about into over after before ' +
  'as so not no nor too very just also only both all any each other another ' +
  'some such own same s t d ll m o re ve y ain aren couldn didn doesn hadn ' +
  'hasn haven isn ma mightn mustn needn shan shouldn wasn weren won wouldn ' +
  'please tell say said get got give given go goes went make made take taken ' +
  'up down out off again further once during between through above below'
).split(/\s+/));

const CJK_STOPGRAMS = new Set(['什么', '怎么', '怎样', '哪个', '哪些', '时候', '哪里', '为什么',
  '一个', '这个', '那个', '他们', '她们', '我们', '你们', '自己', '还是', '以及', '但是', '可是',
  '没有', '不是', '就是', '可以', '应该', '可能', '知道', '告诉', '请问']);

export function splitLatinCjk(text) {
  const source = String(text ?? '');
  const latinWords = [];
  for (const match of source.matchAll(/[A-Za-z][A-Za-z'’\-]*/g)) {
    latinWords.push({ word: match[0], start: match.index });
  }
  const cjkRuns = [];
  for (const match of source.matchAll(/[\u3400-\u9fff]+/g)) {
    cjkRuns.push(match[0]);
  }
  return { latinWords, cjkRuns };
}

// 查询分析：内容词 + 实体候选（原文大小写保留的拉丁词）+ 问题类型。
export function analyzeQuery(query) {
  const text = String(query ?? '');
  const lower = text.toLowerCase();
  const content = new Set();
  const entities = new Set();

  const { latinWords, cjkRuns } = splitLatinCjk(text);
  for (const { word, start } of latinWords) {
    const lw = word.toLowerCase().replace(/[’']/g, '');
    if (lw.length < 2 || EN_STOPWORDS.has(lw)) continue;
    content.add(lw);
    // 句首以外的首字母大写词 → 实体候选（人名/地名/机构）。
    const atStart = start === 0;
    if (!atStart && /^[A-Z]/.test(word) && word.length >= 2) entities.add(word.toLowerCase());
  }
  // 单字母缩写对（如 "QR"）与数字串也保留。
  for (const match of lower.matchAll(/\b[a-z0-9][a-z0-9._-]{1,}\b/g)) {
    const token = match[0];
    if (/\d/.test(token) && !content.has(token)) content.add(token);
  }
  for (const run of cjkRuns) {
    const chars = [...run];
    for (let i = 0; i + 1 < chars.length; i += 1) {
      const bigram = chars[i] + chars[i + 1];
      if (!CJK_STOPGRAMS.has(bigram)) content.add(bigram);
    }
    if (chars.length === 1) content.add(run);
  }

  const lowerText = lower;
  const isTemporal = /\b(when|what year|what time|how long|how old|how many years|ago|date)\b/.test(lowerText)
    || /什么时候|哪一年|哪天|哪个月|多久/.test(text);
  const isComparative = /\b(both|common|same|similar|share[ds]?|alike|together)\b/.test(lowerText)
    || /共同|都|一样|相似/.test(text);
  return {
    content: [...content],
    entities: [...entities],
    isTemporal,
    isComparative,
  };
}

export function newFact(input = {}) {
  const statement = oneLine(input.statement || '');
  if (!statement) throw new MemError('fact 需要 statement', 'BAD_FACT');
  return {
    schema: FACTS_SCHEMA,
    id: input.id || `f-${sha256(statement + '|' + (input.session_key || '')).slice(0, 12)}`,
    record_id: input.record_id || '',
    session_key: input.session_key || '',
    turn_refs: input.turn_refs ?? [],
    statement,
    turn_text: oneLine(input.turn_text || ''),
    quote: oneLine(input.quote || ''),
    speakers: (input.speakers ?? []).map((item) => String(item)).filter(Boolean),
    entities: (input.entities ?? []).map((item) => String(item)).filter(Boolean),
    date_iso: input.date_iso || null,
    said_iso: input.said_iso || null,
    date_text: oneLine(input.date_text || ''),
    kind: input.kind || 'event',
    confidence: Number.isFinite(Number(input.confidence)) ? Number(input.confidence) : 0.8,
  };
}

export function factsFileFor(dir) {
  return path.join(dir, 'content', 'facts', 'facts.jsonl');
}

export function loadFactsFromDir(dir) {
  const file = factsFileFor(dir);
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.split(/\r?\n/).filter((line) => line.trim() !== '')
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
}

export function saveFactsToDir(dir, facts) {
  const file = factsFileFor(dir);
  ensureDir(path.dirname(file));
  const text = facts.map((fact) => JSON.stringify(fact)).join('\n') + (facts.length ? '\n' : '');
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

const SCAN_CACHE = new Map(); // dir -> {mtimeMs, size, facts}

export function allFactsForRecord(cfg, recordLike) {
  const dir = recordLike.dir;
  if (!dir) return [];
  const file = factsFileFor(dir);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return [];
  }
  const cached = SCAN_CACHE.get(dir);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.facts;
  const facts = loadFactsFromDir(dir).map((fact) => ({ ...fact, record_dir: dir }));
  SCAN_CACHE.set(dir, { mtimeMs: stat.mtimeMs, size: stat.size, facts });
  return facts;
}

export function allFacts(cfg) {
  const catalog = loadCatalog(cfg);
  const out = [];
  for (const item of catalog.records) {
    // 读时活跃视图过滤（2609.08258）：被 supersede/contested/retracted 的记录，
    // 其事实默认不再进入召回（审计层仍完整保留，--history 可显式读取）。
    if (item.standing && item.standing !== 'current') continue;
    // catalog 里的 dir 是相对 root 的路径，必须经 resolveRecord 转绝对路径。
    let dir;
    try {
      dir = resolveRecord(cfg, item.id).dir;
    } catch {
      continue;
    }
    out.push(...allFactsForRecord(cfg, { dir }));
  }
  return out;
}

export function invalidateFactCache(dir) {
  if (dir) SCAN_CACHE.delete(dir);
  else SCAN_CACHE.clear();
}

// ---------------------------------------------------------------------------
// 打分
// ---------------------------------------------------------------------------

function haystacksFor(fact) {
  return {
    statement: (fact.statement || '').toLowerCase(),
    who: [fact.speakers.join(' '), fact.entities.join(' ')].join(' ').toLowerCase(),
    turn: (fact.turn_text || '').toLowerCase(),
    date: [fact.date_text || '', fact.date_iso || ''].join(' ').toLowerCase(),
  };
}

export function factScore(fact, analysis) {
  const { content, entities: queryEntities, isTemporal, isComparative } = analysis;
  if (content.length === 0) return { score: 0, reasons: [] };
  const hay = haystacksFor(fact);
  let score = 0;
  let hits = 0;
  const reasons = [];
  for (const term of content) {
    let hit = 0;
    if (hay.who.includes(term)) hit += 4;
    if (hay.statement.includes(term)) hit += 3;
    if (hay.turn.includes(term)) hit += 1;
    if (hit > 0) {
      score += hit;
      hits += 1;
    }
  }
  if (hits === 0) return { score: 0, reasons: [] };

  // 实体覆盖：问题里的实体名命中事实的 speakers/entities 是最强信号。
  let entityHits = 0;
  for (const entity of queryEntities) {
    if (hay.who.includes(entity) || hay.statement.includes(entity)) entityHits += 1;
  }
  if (queryEntities.length > 0) {
    if (entityHits === queryEntities.length) {
      score += 4 + entityHits;
      reasons.push('all-entities');
    } else if (entityHits > 0) {
      score += 1.5 + entityHits * 0.5;
      reasons.push(`${entityHits}/${queryEntities.length} entities`);
    } else {
      score -= 1.5; // 问题点名了实体而本条完全不涉及 → 降权
    }
  }
  // 对比类问题（"both X and Y"）：双实体事实仅作小幅加分——
  // 具体的单边事实（各自的职业/爱好/经历）才是答案来源，泛化的“互相支持”类不值高分。
  if (isComparative && entityHits >= 2) {
    score += 1.5;
    reasons.push('comparative');
  }
  if (isTemporal && fact.date_iso) {
    score += 2;
    reasons.push('dated');
  }

  const coverage = hits / content.length;
  score *= 0.55 + 0.45 * coverage;
  score *= fact.confidence ?? 0.8;
  return { score, reasons };
}

// ---------------------------------------------------------------------------
// 记忆联想（association）：确定性事实关联图，无 LLM。
// 关联判定（按强度排序）：
//   1. 实体重叠（共享人名/地名/物品等，Jaccard 或包含关系）
//   2. 同说话人
//   3. 同会话
// 用途：召回时从词面候选出发扩展出完整关联簇（枚举/多跳/对比题的实际收益点）。
// 索引随事实缓存失效重建；纯内存计算（万级事实 < 50ms）。
// ---------------------------------------------------------------------------

const ASSOC_INDEX_CACHE = new Map(); // dir-set key -> {built, byId, entityIndex, speakerIndex, sessionIndex}

function factKey(fact) {
  return fact.id;
}

function entitySetOf(fact) {
  const s = new Set();
  for (const e of fact.entities ?? []) {
    const k = String(e).trim().toLowerCase();
    if (k.length >= 2) s.add(k);
  }
  for (const sp of fact.speakers ?? []) {
    const k = String(sp).trim().toLowerCase();
    if (k.length >= 2) s.add(k);
  }
  return s;
}

export function buildAssociationIndex(facts) {
  const byId = new Map();
  const entityIndex = new Map(); // entity -> fact ids
  const speakerIndex = new Map();
  const sessionIndex = new Map();
  for (const fact of facts) {
    byId.set(factKey(fact), fact);
    for (const e of entitySetOf(fact)) {
      if (!entityIndex.has(e)) entityIndex.set(e, []);
      entityIndex.get(e).push(factKey(fact));
    }
    for (const sp of fact.speakers ?? []) {
      const k = String(sp).toLowerCase();
      if (!speakerIndex.has(k)) speakerIndex.set(k, []);
      speakerIndex.get(k).push(factKey(fact));
    }
    if (fact.session_key) {
      if (!sessionIndex.has(fact.session_key)) sessionIndex.set(fact.session_key, []);
      sessionIndex.get(fact.session_key).push(factKey(fact));
    }
  }
  return { byId, entityIndex, speakerIndex, sessionIndex };
}

// 为一个事实找关联：返回 [{fact, strength, why}]，按强度降序，最多 topN。
export function associatesOf(fact, index, { topN = 4 } = {}) {
  const self = factKey(fact);
  const scores = new Map(); // id -> {strength, why}
  const add = (id, strength, why) => {
    if (id === self) return;
    const prev = scores.get(id);
    if (prev) {
      prev.strength += strength;
      if (!prev.why.includes(why)) prev.why.push(why);
    } else {
      scores.set(id, { strength, why: [why] });
    }
  };
  const ents = [...entitySetOf(fact)];
  for (const e of ents) {
    for (const id of index.entityIndex.get(e) ?? []) {
      add(id, 2, `entity:${e}`);
    }
  }
  for (const sp of fact.speakers ?? []) {
    for (const id of index.speakerIndex.get(String(sp).toLowerCase()) ?? []) {
      add(id, 1, `speaker:${sp}`);
    }
  }
  for (const id of index.sessionIndex.get(fact.session_key) ?? []) {
    add(id, 0.5, 'same-session');
  }
  const out = [];
  for (const [id, { strength, why }] of scores) {
    const other = index.byId.get(id);
    if (!other) continue;
    out.push({ fact: other, strength, why: why.join(',') });
  }
  out.sort((a, b) => b.strength - a.strength);
  return out.slice(0, topN);
}

// 候选集关联扩展：取种子候选的关联事实并入候选（去重）。
// seeds: lexicalCandidates 的结果；返回扩展后的候选列表（不超过 cap）。
export function expandWithAssociations(candidates, factsIndex, { seeds = 8, perSeed = 2, cap = 48 } = {}) {
  const seen = new Set(candidates.map((c) => factKey(c.fact)));
  const merged = [...candidates];
  for (const c of candidates.slice(0, seeds)) {
    const assoc = associatesOf(c.fact, factsIndex, { topN: perSeed });
    for (const { fact, strength, why } of assoc) {
      if (seen.has(factKey(fact))) continue;
      seen.add(factKey(fact));
      merged.push({
        fact,
        score: 1, // 关联扩展进来的词面分未知，给基础分；重排会重新判
        reasons: [`assoc(${why},s=${strength.toFixed(1)})`],
        analysis: c.analysis,
      });
    }
    if (merged.length >= cap) break;
  }
  merged.sort((a, b) => b.score - a.score);
  return merged.slice(0, cap);
}

export function associationIndexFor(cfg) {
  // 缓存键：全部记录目录集合（简单起见用 allFacts 的引用一致性由调用方管理）。
  const facts = allFacts(cfg);
  const key = sha256(facts.map((f) => f.id).join(','));
  const cached = ASSOC_INDEX_CACHE.get(key);
  if (cached) return { facts, index: cached };
  const index = buildAssociationIndex(facts);
  ASSOC_INDEX_CACHE.clear();
  ASSOC_INDEX_CACHE.set(key, index);
  return { facts, index };
}

export function invalidateAssociationCache() {
  ASSOC_INDEX_CACHE.clear();
}

// 词面候选生成：返回按分排序的 {fact, score, reasons}。
export function lexicalCandidates(cfg, query, { limit = 24, recordIds = null } = {}) {
  const analysis = analyzeQuery(query);
  const facts = allFacts(cfg);
  const idFilter = recordIds && recordIds.length > 0 ? new Set(recordIds.map((id) => normKey(id))) : null;
  const scored = [];
  for (const fact of facts) {
    if (idFilter && !idFilter.has(normKey(fact.record_id || ''))) continue;
    const { score, reasons } = factScore(fact, analysis);
    if (score > 0) scored.push({ fact, score, reasons, analysis });
  }
  scored.sort((a, b) => b.score - a.score);
  return { analysis, candidates: scored.slice(0, limit) };
}

// dialog 对外 id（sample_id）→ 记录 id。按 project=dialog:<id> 或 aliases 匹配。
export function resolveDialogRecordIds(cfg, dialogId) {
  const catalog = loadCatalog(cfg);
  const wanted = normKey(dialogId);
  const ids = [];
  for (const item of catalog.records) {
    const projectMatch = normKey(item.project || '') === normKey(`dialog:${dialogId}`);
    const aliasMatch = (item.aliases ?? []).some((alias) => normKey(alias) === wanted);
    const idMatch = normKey(item.id) === wanted;
    if (projectMatch || aliasMatch || idMatch) ids.push(item.id);
  }
  return ids;
}

export function formatFactLine(fact, { withQuote = false } = {}) {
  // 只显示解析后的事件日期（v2 审计：双日期显示会诱导答题模型自己做二次推算出错）。
  const date = fact.date_iso ? `[${fact.date_iso}] ` : (fact.said_iso ? `[said ${fact.said_iso}] ` : '');
  const who = fact.speakers.length ? `(${fact.speakers.join(' & ')}) ` : '';
  // 引句默认不进片段（v4 审计：加长片段对 open-domain/multi-hop 是噪声）；canonical 保留。
  const quote = withQuote && fact.quote ? ` — 「${truncate(fact.quote, 90)}」` : '';
  return truncate(`${date}${who}${fact.statement}${quote}`, 300);
}

// ---------------------------------------------------------------------------
// 完整事实召回：词面候选 → （可选）语义重排 → 阈值选择/弃答
// ---------------------------------------------------------------------------

// 召回输出的使用说明（记忆系统的输出语义，非答案指令）：
// 事实是 canonical 陈述；问题的前提可能有误（主体/细节被张冠李戴），
// 内容匹配即作答；多条事实可组合推断。config.semantic.premiseNote 可关。
export const RECALL_USAGE_NOTE = [
  '【记忆使用说明】以下是按相关性选出的事实。事实的归属主体可能与问题中提到的主体不同',
  '（问题的前提可能有误）：只要事实内容本身与问题的核心匹配，就直接依据事实内容回答，',
  '不要因为主体不同而回答「不知道」；多条事实可以组合起来推断作答；',
  '只有当下面完全没有相关内容时才回答「不知道」。',
].join(' ');

export async function recallFacts(cfg, options = {}) {
  const started = Date.now();
  const query = String(options.query ?? '').trim();
  if (!query) return { query, items: [], abstained: false, candidates: 0, took_ms: 0 };
  const k = Math.max(1, Number(options.k) || 4);
  const useSemantic = options.semantic !== false;

  // 动态引入避免 facts → semantic 顶层依赖循环（semantic 不依赖 facts，直接引也行；
  // 保持惰性让无配置环境零开销）。
  const { rerankFacts, expandQuery, selectAfterRerank, semanticConfig } = await import('./semantic.mjs');
  const sem = semanticConfig(cfg);

  const recordIds = options.dialogId ? resolveDialogRecordIds(cfg, options.dialogId) : null;
  const candidateLimit = useSemantic && sem.enabled ? sem.rerankCandidates : k * 3;
  let { analysis, candidates } = lexicalCandidates(cfg, query, { limit: candidateLimit, recordIds });

  // 记忆联想扩展（v6.3）：从词面种子出发拉取关联事实，让重排看到完整关联簇。
  // 确定性、无 LLM；默认开启，config.recall.assocExpand=false 关闭（消融口径）。
  let assocExpanded = 0;
  if (candidates.length > 0 && cfg.recall?.assocExpand !== false) {
    const { index } = associationIndexFor(cfg);
    const before = new Set(candidates.map((c) => c.fact.id));
    const expandedList = expandWithAssociations(candidates, index, {
      seeds: 8,
      perSeed: 2,
      cap: Math.max(candidateLimit, 48),
    });
    assocExpanded = expandedList.length - candidates.length;
    candidates = expandedList;
    void before;
  }

  // 弱召回扩展：词面命中太少或太弱时，用语义变体再检索一轮并合并候选。
  let expanded = null;
  if (useSemantic && sem.enabled && sem.expansion) {
    const topScore = candidates[0]?.score ?? 0;
    if (candidates.length < Math.min(k + 2, 6) || topScore < 4) {
      try {
        expanded = await expandQuery(cfg, query);
        if (expanded && expanded.length > 0) {
          const seen = new Set(candidates.map((c) => c.fact.id));
          const merged = [...candidates];
          for (const variant of expanded) {
            const more = lexicalCandidates(cfg, variant, { limit: 12, recordIds });
            for (const c of more.candidates) {
              if (seen.has(c.fact.id)) continue;
              seen.add(c.fact.id);
              merged.push({ ...c, reasons: [...(c.reasons ?? []), 'expanded'] });
            }
          }
          merged.sort((a, b) => b.score - a.score);
          candidates = merged.slice(0, candidateLimit);
        }
      } catch { /* 扩展失败不影响主路径 */ }
    }
  }

  let selection = { items: candidates.slice(0, k), abstained: candidates.length === 0 };
  let digest = null;
  let semanticUsed = false;
  if (useSemantic && sem.enabled && candidates.length > 0) {
    try {
      const { scores, digest: digestText } = await rerankFacts(cfg, query, candidates);
      digest = digestText;
      selection = selectAfterRerank(candidates, scores, {
        k,
        minScore: options.rerankMinScore ?? sem.rerankMinScore,
      });
      semanticUsed = true;
    } catch (error) {
      // 语义层故障（限流/超时/平台故障）：退化为纯词面召回，不让错误传出召回边界。
      process.stderr.write(`[facts] 语义重排失败，退化词面召回：${error.message}\n`);
      selection = { items: candidates.slice(0, k), abstained: candidates.length === 0 };
    }
  }

  const items = selection.items.map((item) => ({
    type: 'fact',
    id: item.fact.id,
    record_id: item.fact.record_id,
    session_key: item.fact.session_key,
    statement: item.fact.statement,
    snippet: formatFactLine(item.fact),
    speakers: item.fact.speakers,
    date_iso: item.fact.date_iso,
    kind: item.fact.kind,
    score: item.score,
    rerank: item.rerank ?? null,
    reasons: item.reasons ?? [],
  }));

  // 多实体覆盖保障：问题点名了多个实体（"A and B both…"）而选中结果里
  // 某个实体完全缺席时，用覆盖该实体的最佳词面候选替换掉与任何实体都无关的末位结果。
  const queryEntities = (analysis.entities ?? []).map((entity) => entity.toLowerCase());
  if (queryEntities.length >= 2 && items.length > 0) {
    const covers = (item, entity) => {
      const hay = `${item.statement} ${item.speakers.join(' ')}`.toLowerCase();
      return hay.includes(entity);
    };
    const selectedIds = new Set(items.map((item) => item.id));
    for (const entity of queryEntities) {
      if (items.some((item) => covers(item, entity))) continue;
      const donor = candidates.find(
        (c) => !selectedIds.has(c.fact.id)
          && `${c.fact.statement} ${c.fact.speakers.join(' ')}`.toLowerCase().includes(entity),
      );
      if (!donor) continue;
      let replaceAt = items.findIndex((item) => !queryEntities.some((e) => covers(item, e)));
      if (replaceAt === -1) replaceAt = items.length - 1;
      const fact = donor.fact;
      items[replaceAt] = {
        type: 'fact',
        id: fact.id,
        record_id: fact.record_id,
        session_key: fact.session_key,
        statement: fact.statement,
        snippet: formatFactLine(fact),
        speakers: fact.speakers,
        date_iso: fact.date_iso,
        kind: fact.kind,
        score: donor.score,
        rerank: null,
        reasons: ['entity-coverage'],
      };
      selectedIds.add(fact.id);
    }
  }

  // 记忆摘要作为第一条片段：忠实整合相关事实（枚举完整列举/共同点对比/可标注推断），
  // 由重排调用一并产出；为空时省略。
  const snippets = [];
  if (digest) snippets.push(`【相关记忆整合】${digest}`);
  for (const item of items) snippets.push(item.snippet);

  return {
    query,
    analysis: {
      content_terms: analysis.content,
      entities: analysis.entities,
      is_temporal: analysis.isTemporal,
      is_comparative: analysis.isComparative,
      expanded,
    },
    items,
    snippets,
    abstained: selection.abstained,
    candidates: candidates.length,
    assoc_expanded: assocExpanded,
    semantic: semanticUsed,
    digest,
    took_ms: Date.now() - started,
  };
}
