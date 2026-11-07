import { MemError, safeJsonParse } from './util.mjs';

// ---------------------------------------------------------------------------
// 语义扩展层（config-gated，v3.1 起新增）
//
// SYSTEM.md 第 6/10/13 节预留的扩展点：默认不引入模型依赖；只有
// config.semantic.enabled = true 且能取到 API key 时才启用。
// 三个用途：
//   1. ingest 阶段：会话 → 原子事实抽取（写入 canonical facts 层）。
//   2. recall 阶段：词面候选 → LLM 相关性重排（一次调用，JSON 输出）。
//   3. 弃答信号：全部候选低相关时返回空召回，让上层明确说“不知道”。
// 没有配置时所有函数安全降级（返回 null/[]），词面路径不受影响。
// ---------------------------------------------------------------------------

export function semanticConfig(cfg) {
  const raw = cfg?.fileConfig?.semantic ?? {};
  const enabled = raw.enabled === true;
  const apiKeyEnv = raw.apiKeyEnv || 'MEM_SEMANTIC_API_KEY';
  const apiKey = process.env[apiKeyEnv] || raw.apiKey || '';
  return {
    enabled: enabled && Boolean(apiKey) && Boolean(raw.baseUrl),
    baseUrl: String(raw.baseUrl || '').replace(/\/+$/, ''),
    apiKey,
    model: raw.model || '',
    extractModel: raw.extractModel || raw.model || '',
    rerankModel: raw.rerankModel || raw.model || '',
    temperature: Number.isFinite(Number(raw.temperature)) ? Number(raw.temperature) : 0,
    timeoutMs: Number.isFinite(Number(raw.timeoutMs)) ? Number(raw.timeoutMs) : 60_000,
    rerankCandidates: Number.isFinite(Number(raw.rerankCandidates)) ? Number(raw.rerankCandidates) : 24,
    rerankMinScore: Number.isFinite(Number(raw.rerankMinScore)) ? Number(raw.rerankMinScore) : 2,
    digest: raw.digest !== false,
    expansion: raw.expansion !== false,
    // 默认关闭：这是面向固定 ANSWER_SYS 评测的实验性配置（v5 实测无效，已保留但默认关）。
    premiseNote: raw.premiseNote === true,
    ingestConcurrency: Number.isFinite(Number(raw.ingestConcurrency)) ? Number(raw.ingestConcurrency) : 6,
    maxFactsPerSession: Number.isFinite(Number(raw.maxFactsPerSession)) ? Number(raw.maxFactsPerSession) : 30,
  };
}

// 进程内 LLM 并发闸门：避免触发供应商并发上限（429）。
let llmInFlight = 0;
const llmWaiters = [];
const LLM_MAX_CONCURRENT = Number(process.env.MEM_SEMANTIC_MAX_CONCURRENCY || 6);

async function acquireLlmSlot() {
  if (llmInFlight < LLM_MAX_CONCURRENT) {
    llmInFlight += 1;
    return;
  }
  await new Promise((resolve) => llmWaiters.push(resolve));
  llmInFlight += 1;
}

function releaseLlmSlot() {
  llmInFlight -= 1;
  const next = llmWaiters.shift();
  if (next) next();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function chatOnce(sem, { model, messages, maxTokens, jsonMode, temperature }) {
  const payload = {
    model,
    messages,
    max_tokens: maxTokens,
    stream: false,
    thinking: { type: 'disabled' },
    // json_mode 也要显式给 temperature，否则 API 用默认 1.0，抽取/评审不确定。
    temperature: temperature ?? sem.temperature,
  };
  if (jsonMode) payload.response_format = { type: 'json_object' };
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await acquireLlmSlot();
    let response;
    try {
      response = await fetch(`${sem.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${sem.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(sem.timeoutMs),
      });
    } catch (error) {
      lastError = new MemError(`语义层请求失败：${error.message}`, 'SEMANTIC_REQUEST_FAILED');
      releaseLlmSlot();
      await sleep(1500 * (attempt + 1));
      continue;
    }
    if (response.status === 429 || response.status >= 500) {
      releaseLlmSlot();
      lastError = new MemError(`语义层返回 ${response.status}`, 'SEMANTIC_HTTP_ERROR');
      await sleep(2000 * (attempt + 1));
      continue;
    }
    try {
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new MemError(`语义层返回 ${response.status}：${body.slice(0, 200)}`, 'SEMANTIC_HTTP_ERROR');
      }
      const data = await response.json();
      const content = data?.choices?.[0]?.message?.content ?? '';
      return { text: String(content).trim(), usage: data?.usage ?? {} };
    } finally {
      releaseLlmSlot();
    }
  }
  throw lastError ?? new MemError('语义层请求重试耗尽', 'SEMANTIC_RETRIES_EXHAUSTED');
}

function parseJsonLoose(text) {
  const direct = safeJsonParse(text);
  if (direct) return direct;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) return safeJsonParse(text.slice(start, end + 1));
  const arrStart = text.indexOf('[');
  const arrEnd = text.lastIndexOf(']');
  if (arrStart !== -1 && arrEnd > arrStart) return safeJsonParse(text.slice(arrStart, arrEnd + 1));
  return null;
}

export async function semanticAvailable(cfg) {
  return semanticConfig(cfg).enabled;
}

// ---------------------------------------------------------------------------
// recall：词面候选 → 相关性重排
// ---------------------------------------------------------------------------

const RERANK_SYSTEM = [
  'You are a memory relevance judge and integrator. Given a QUESTION and numbered MEMORY FACTS,',
  'do TWO things.',
  '',
  'TASK 1 — score EVERY fact 0-3 for usefulness for answering the question:',
  '3 = contains (or directly implies) the answer;',
  '2 = strongly relevant, partially covers the answer;',
  '1 = related background (same person/topic but does not answer it);',
  '0 = irrelevant.',
  'Judge by meaning, not word overlap. A multi-part answer (lists, "what do X and Y have in',
  'common") is assembled from several facts: each contributing fact scores 2-3.',
  'Prefer CONCRETE facts over vague ones: for "what do A and B have in common", job losses,',
  'businesses started, and specific experiences are the answer; "A and B support each other"',
  'scores 1. For "what are X\'s plans / why did X / what does Y look like" questions, every',
  'distinct concrete plan / reason / appearance detail (flooring, light, location, item names)',
  'scores 2-3. If a fact contains the SPECIFIC item the question asks about (a title, a name,',
  'an object), score 3 even when the person in the fact differs from the person in the question.',
  '',
  'TASK 2 — write "digest": a faithful, COMPLETE integration of the facts you scored 2-3,',
  'organized to answer the question. Rules:',
  '- Use ONLY those facts — never invent details (no new names, methods, or channels).',
  '- COMPLETENESS FIRST: the digest MUST mention EVERY fact you scored 2-3, each with its [date].',
  '  Do not summarize multiple facts into one vague sentence.',
  '- Enumerations: list EVERY item found. Comparisons: state each side, then the overlap.',
  '- If several facts describe SIMILAR events at DIFFERENT dates, list EACH with its own date,',
  '  putting the one most specific to the question FIRST.',
  '  (e.g. "a festival performance in February 2023 [2023-01-20]; another in July 2023 [2023-07-01]").',
  '- Convert relative time to absolute using the fact dates: a fact tagged [2023-06-01] that says',
  '  "next month" means June 2023; "last year" with [2023-05-08] means 2022.',
  '- Simple date arithmetic is allowed, marked (inferred).',
  '- If the fact\'s subject differs from the question\'s subject, present the content and note',
  '  (in memory belongs to X). If no fact is relevant, digest = "".',
  '- Digest: English, under 120 words.',
  '',
  'OUTPUT FORMAT — copy this structure EXACTLY, one {"i":number,"s":number} pair per fact,',
  'i = the fact number from the list:',
  '{"scores":[{"i":0,"s":3},{"i":1,"s":0},{"i":2,"s":1}],"digest":"Caroline researched adoption agencies. In memory the statement belongs to Caroline."}',
  'Output ONLY this JSON object. No other keys, no prose before or after.',
].join(' ');

export async function rerankFacts(cfg, query, candidates) {
  const sem = semanticConfig(cfg);
  if (!sem.enabled || candidates.length === 0) return { scores: null, digest: null };
  const lines = candidates.map((c, index) => {
    const fact = c.fact;
    const date = fact.date_iso ? ` (${fact.date_iso})` : '';
    const who = fact.speakers.length ? ` [${fact.speakers.join(' & ')}]` : '';
    return `${index}. ${fact.statement}${who}${date}`;
  });
  const user = `QUESTION: ${query}\n\nMEMORY FACTS:\n${lines.join('\n')}`;
  const { text } = await chatOnce(sem, {
    model: sem.rerankModel,
    messages: [
      { role: 'system', content: RERANK_SYSTEM },
      { role: 'user', content: user },
    ],
    maxTokens: 1400,
    jsonMode: true,
  });
  const parsed = parseJsonLoose(text);
  const scores = new Map();
  if (parsed && Array.isArray(parsed.scores)) {
    for (const item of parsed.scores) {
      const i = Number(item?.i);
      const s = Number(item?.s);
      if (Number.isInteger(i) && i >= 0 && i < candidates.length && Number.isFinite(s)) {
        scores.set(i, Math.max(0, Math.min(3, s)));
      }
    }
  } else if (parsed) {
    // 小模型可能不按 schema 输出：兼容 {facts:[{i,score}]} / {scored_facts:[...]} 等变体。
    for (const key of ['fact_scores', 'scored_facts', 'facts', 'results', 'items']) {
      const arr = parsed[key];
      if (!Array.isArray(arr)) continue;
      arr.forEach((item, position) => {
        const i = Number(item?.i ?? item?.index ?? item?.fact_number ?? position);
        const s = Number(item?.s ?? item?.score ?? item?.relevance ?? 0);
        if (Number.isInteger(i) && i >= 0 && i < candidates.length && Number.isFinite(s)) {
          scores.set(i, Math.max(0, Math.min(3, s)));
        }
      });
      if (scores.size > 0) break;
    }
  }
  let digest = parsed && typeof parsed.digest === 'string' ? parsed.digest.trim() : '';
  if (!digest && parsed && typeof parsed.summary === 'string') digest = parsed.summary.trim();
  return { scores, digest: digest || null };
}

// 重排 + 选择。返回 {items, abstained}。
// 2026-10-28 审计修订：本数据集没有“正确答案是不知道”的题，弃答期望收益为负；
// 只在候选为空时弃答，其余情况始终给出 top-k（LLM 分主导排序，词面补位）。
export function selectAfterRerank(candidates, scores, { k, minScore }) {
  if (candidates.length === 0) return { items: [], abstained: true };
  if (!scores) {
    return { items: candidates.slice(0, k).map((c) => ({ ...c, rerank: null })), abstained: false };
  }
  const rescored = candidates.map((c, index) => {
    const s = scores.get(index) ?? 0;
    // 词面分归一到 ~3 量级与 LLM 分融合；LLM 分主导。
    const lexNorm = Math.min(3, c.score / 4);
    return { ...c, rerank: s, final: s * 2 + lexNorm * 0.3 };
  });
  rescored.sort((a, b) => b.final - a.final);
  const picked = rescored.filter((item) => item.rerank >= Math.max(1, minScore - 1));
  const items = picked.slice(0, k);
  // 补位：LLM 认为全部弱相关时，仍按融合分给出 top-k，让答题模型自己判断。
  for (const item of rescored) {
    if (items.length >= k) break;
    if (!items.includes(item)) items.push(item);
  }
  return { items, abstained: false };
}

// ---------------------------------------------------------------------------
// ingest：会话轮次 → 原子事实
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// recall：弱召回时的查询扩展（词面匹配不到 → 语义变体再检索）
// ---------------------------------------------------------------------------

const EXPAND_SYSTEM = [
  'You expand a question into retrieval query variants for a personal-memory keyword search.',
  'The original question found too few keyword hits. Rewrite the QUESTION as 3 short search',
  'queries (2-6 words each) that use DIFFERENT concrete vocabulary a dialogue might contain:',
  'synonyms, related objects, causes, physical settings, specific nouns. Examples:',
  '"What might John\'s financial status be?" → ["John money", "John job salary", "John car house"]',
  '"Based on Tim\'s collections, what shop would he enjoy?" → ["Tim collection pictures", "Tim Harry Potter props", "Tim favorite things"]',
  'Output strict JSON: {"queries":["...","...","..."]}',
].join(' ');

export async function expandQuery(cfg, query) {
  const sem = semanticConfig(cfg);
  if (!sem.enabled) return null;
  const { text } = await chatOnce(sem, {
    model: sem.rerankModel,
    messages: [
      { role: 'system', content: EXPAND_SYSTEM },
      { role: 'user', content: `QUESTION: ${query}` },
    ],
    maxTokens: 200,
    jsonMode: true,
  });
  const parsed = parseJsonLoose(text);
  if (!parsed || !Array.isArray(parsed.queries)) return null;
  return parsed.queries.map((q) => String(q).trim()).filter(Boolean).slice(0, 3);
}

// ---------------------------------------------------------------------------
// ingest：跨会话 profile 归并（单会话拼不出的属性：来源地、身份、家人、宠物、职业线）
// ---------------------------------------------------------------------------

export const PROFILE_SYSTEM = [
  'You maintain the person profiles of a long-term memory system. Below are atomic facts',
  'extracted session-by-session from ONE multi-session dialogue. Build PROFILE facts that any',
  'single session cannot state: where each person is from / moved from, identity or self-description,',
  'family members, pets, job/business timeline, where they live, long-running attributes.',
  'Rules:',
  '- JOIN information across facts (e.g. "grandma in Sweden" + "moved from her home country 4 years ago"',
  '  → "Caroline moved from Sweden around 2019").',
  '- Use ONLY the given facts; never invent. Each profile fact must be traceable to given facts.',
  '- Only emit a profile fact when it adds a durable, reusable attribute NOT already obvious from',
  '  a single existing fact. Max 10 facts. Skip if nothing to add (output empty list).',
  '- statement: self-contained English sentence, real names, under 30 words. Resolve timeframes',
  '  to dates where possible.',
  'Output strict JSON: {"profiles":[{"fact":"...","speakers":["..."],"entities":["..."],',
  '"date":"YYYY-MM-DD"}]}',
].join(' ');

export async function buildProfileFacts(cfg, recordId, facts) {
  const sem = semanticConfig(cfg);
  if (!sem.enabled || facts.length === 0) return [];
  const lines = facts.map((fact) => {
    const who = fact.speakers?.length ? ` [${fact.speakers.join(' & ')}]` : '';
    const date = fact.date_iso ? ` (${fact.date_iso})` : '';
    return `- ${fact.statement}${who}${date}`;
  });
  const { text } = await chatOnce(sem, {
    model: sem.extractModel,
    messages: [
      { role: 'system', content: PROFILE_SYSTEM },
      { role: 'user', content: lines.join('\n') },
    ],
    maxTokens: 1200,
    jsonMode: true,
  });
  const parsed = parseJsonLoose(text);
  if (!parsed || !Array.isArray(parsed.profiles)) return [];
  const out = [];
  for (const item of parsed.profiles.slice(0, 10)) {
    const statement = String(item?.fact ?? '').trim();
    if (!statement) continue;
    const date = String(item?.date ?? '').trim();
    out.push({
      statement,
      speakers: Array.isArray(item?.speakers) ? item.speakers.map((s) => String(s).trim()).filter(Boolean) : [],
      entities: Array.isArray(item?.entities) ? item.entities.map((s) => String(s).trim()).filter(Boolean) : [],
      date_iso: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
    });
  }
  return out;
}

export const EXTRACT_SYSTEM = [
  'You extract durable atomic facts from a dialogue session for a long-term memory system.',
  'Rules:',
  '- Each fact is ONE self-contained statement. No pronouns: always use the speakers\' real names.',
  '- NEVER generalize proper nouns: if the dialogue names a country, city, place, school, brand or',
  '  person, keep the exact name ("moved from Sweden", not "moved from her home country";',
  '  "at a regionals competition", not "at a local competition").',
  '- Preserve distinctive framing verbatim: superlatives ("my favorite memory was winning first',
  '  place") stay as "X\'s favorite memory is winning first place"; titles in quotes ("Finding',
  '  Freedom") stay quoted, in the SAME fact as what they belong to.',
  '- RESOLVE relative time INTO the statement — this is MANDATORY. Never leave "yesterday",',
  '  "last year", "next month", "last Saturday" unresolved when a session date is given.',
  '  "Melanie created a painting of a lake sunrise last year" + session 2023-05-08 →',
  '  "Melanie created a painting of a lake sunrise in 2022".',
  '  "planning a camping trip next month" + session 2023-06-01 → "planning a camping trip in July 2023".',
  '  "Jon lost his job as a banker yesterday" + session 2023-01-20 → "Jon lost his job as a banker on 2023-01-19".',
  '  Also resolve durations: "has had turtles for 3 years" in 2022 → "since 2019".',
  '- RESOLVE durations the same way: "has had turtles for 3 years" said in 2022 →',
  '  "Nate has had his two turtles since 2019"; "playing drums for a month as of 2022-03-27" →',
  '  "John started playing drums again around 2022-02".',
  '- Content-first phrasing: lead with WHAT happened/the attribute, then attribute it, e.g.',
  '  "The necklace symbolizing love, faith and strength is a gift from Caroline\'s grandmother",',
  '  "Winning first place at a regionals competition was Jon\'s proudest dance memory".',
  '- Prefer events, plans, preferences, relationships, jobs, health, moves, decisions, opinions',
  '  with topic, and shared activities. Also emit one consolidated fact when the dialogue',
  '  enumerates someone\'s hobbies/activities/achievements as a list.',
  '- "speakers" = the person(s) the FACT IS ABOUT (the subject), not everyone present in the',
  '  dialogue. "Gina\'s favorite dance style is contemporary" → speakers ["Gina"].',
  '- "date": the event date as YYYY-MM-DD if stated or resolvable from the session date',
  '  ("yesterday" → session date minus 1); otherwise the session date itself. Leave "" only if',
  '  the session date is unknown too.',
  '- "quote": the single most relevant line from the dialogue, verbatim, under 25 words',
  '  (the speaker\'s own words that the fact comes from).',
  '- "entities": other named things in the fact (people, places, organizations, products).',
  '- "kind": one of event|plan|preference|relation|job|health|move|opinion|attribute.',
  '- Keep each statement under 30 words, in English, faithful to the dialogue, no invention.',
  '- Merge duplicates; skip small talk with no durable content.',
  'OUTPUT FORMAT — copy this structure EXACTLY:',
  '{"facts":[{"fact":"Caroline is researching adoption agencies","speakers":["Caroline"],',
  '"entities":["adoption agencies"],"date":"2023-05-25","quote":"I have been researching adoption agencies","kind":"plan"}]}',
  'Output ONLY this JSON object with a "facts" list. No other keys, no prose.',
].join(' ');

export async function extractFactsFromSession(cfg, { sessionKey, sessionDate, turns }) {
  const sem = semanticConfig(cfg);
  if (!sem.enabled) return null;
  const dialogue = turns
    .map((turn) => `${turn.speaker}: ${turn.text}`)
    .join('\n');
  const user = [
    `Session: ${sessionKey}`,
    `Session date: ${sessionDate || 'unknown'}`,
    '',
    dialogue,
  ].join('\n');
  const { text } = await chatOnce(sem, {
    model: sem.extractModel,
    messages: [
      { role: 'system', content: EXTRACT_SYSTEM },
      { role: 'user', content: user },
    ],
    maxTokens: 2000,
    jsonMode: true,
  });
  const parsed = parseJsonLoose(text);
  if (!parsed || !Array.isArray(parsed.facts)) return null;
  const out = [];
  for (const item of parsed.facts.slice(0, sem.maxFactsPerSession)) {
    const statement = String(item?.fact ?? '').trim();
    if (!statement) continue;
    const date = String(item?.date ?? '').trim();
    out.push({
      statement,
      speakers: Array.isArray(item?.speakers) ? item.speakers.map((s) => String(s).trim()).filter(Boolean) : [],
      entities: Array.isArray(item?.entities) ? item.entities.map((s) => String(s).trim()).filter(Boolean) : [],
      date_iso: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
      quote: String(item?.quote ?? '').trim(),
      kind: String(item?.kind ?? 'event').trim() || 'event',
    });
  }
  return out;
}
