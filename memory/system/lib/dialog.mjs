import fs from 'node:fs';
import path from 'node:path';
import {
  createRecord,
  loadCatalog,
  loadConfig,
  loadRecord,
  resolveRecord,
  saveRecord,
  setDigest,
} from './store.mjs';
import {
  MemError,
  ensureDir,
  oneLine,
  sha256,
  slugify,
  truncate,
  writeJson,
} from './util.mjs';
import {
  allFactsForRecord,
  invalidateFactCache,
  loadFactsFromDir,
  newFact,
  saveFactsToDir,
} from './facts.mjs';
import { extractFactsFromSession, semanticConfig } from './semantic.mjs';

// ---------------------------------------------------------------------------
// 对话摄入：一个多会话对话 → 一条 episode 记录
//   L0 卡   = 对话级路由（标题/实体/时间范围）
//   L1      = 会话列表 + 时间范围 + 事实统计
//   L3      = content/transcripts/session_N.txt（原始轮次，不改写）
//   facts   = content/facts/facts.jsonl（原子事实；LLM 抽取，词面兜底）
// 幂等：meta.integrity.facts_hash 与源对话 hash 一致且已含事实时跳过重新抽取。
// ---------------------------------------------------------------------------

const MONTHS = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
  september: 9, sep: 9, sept: 9, october: 10, oct: 10, november: 11, nov: 11,
  december: 12, dec: 12,
};

// "1:56 pm on 8 May, 2023" / "4:04 pm on 20 January, 2023" → ISO 日期
export function parseDialogueDate(text) {
  const raw = String(text ?? '');
  const match = raw.match(/(\d{1,2}):(\d{2})\s*(am|pm)?\s+on\s+(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})/i);
  if (match) {
    const day = Number(match[4]);
    const month = MONTHS[match[5].toLowerCase()];
    const year = Number(match[6]);
    if (month && day >= 1 && day <= 31) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }
  const iso = raw.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  return null;
}

export function normalizeDialog(dialog) {
  const sessions = [];
  for (const [key, value] of Object.entries(dialog.conversation ?? {})) {
    const sessionMatch = key.match(/^session_(\d+)$/);
    if (!sessionMatch) continue;
    const index = Number(sessionMatch[1]);
    const dateRaw = dialog.conversation[`${key}_date_time`] || '';
    const turnsRaw = typeof value === 'string' ? JSON.parse(value) : value;
    const turns = (turnsRaw ?? [])
      .map((turn) => ({
        speaker: String(turn?.speaker ?? '??'),
        text: String(turn?.text ?? '').trim(),
      }))
      .filter((turn) => turn.text);
    sessions.push({ key, index, date_raw: dateRaw, date_iso: parseDialogueDate(dateRaw), turns });
  }
  sessions.sort((a, b) => a.index - b.index);
  return {
    sample_id: dialog.sample_id || 'dialog',
    sessions,
    turns_total: sessions.reduce((sum, session) => sum + session.turns.length, 0),
  };
}

function dialogSourceHash(normalized) {
  return sha256(JSON.stringify(normalized.sessions.map((session) => ({
    k: session.key,
    d: session.date_raw,
    t: session.turns,
  }))));
}

function speakersOf(normalized) {
  const set = new Map();
  for (const session of normalized.sessions) {
    for (const turn of session.turns) {
      set.set(turn.speaker, (set.get(turn.speaker) ?? 0) + 1);
    }
  }
  return [...set.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
}

// 词面兜底：无 LLM 时每轮生成一条“说话人说了什么”级别的弱事实。
function fallbackFacts(normalized, recordId) {
  const facts = [];
  for (const session of normalized.sessions) {
    session.turns.forEach((turn, index) => {
      if (turn.text.length < 24) return;
      facts.push(newFact({
        record_id: recordId,
        session_key: session.key,
        turn_refs: [`${session.key}:${index + 1}`],
        statement: truncate(`${turn.speaker} said: ${turn.text}`, 200),
        turn_text: turn.text,
        speakers: [turn.speaker],
        entities: [],
        date_iso: session.date_iso,
        said_iso: session.date_iso,
        date_text: session.date_raw,
        kind: 'utterance',
        confidence: 0.4,
      }));
    });
  }
  return facts;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function ingestDialog(cfg, dialog, options = {}) {
  const normalized = normalizeDialog(dialog);
  if (normalized.sessions.length === 0) throw new MemError('对话没有可解析的 session', 'EMPTY_DIALOG');
  const sourceHash = dialogSourceHash(normalized);
  const speakers = speakersOf(normalized);
  const dates = normalized.sessions.map((session) => session.date_iso).filter(Boolean);
  const dateRange = dates.length ? `${dates[0]} ~ ${dates[dates.length - 1]}` : 'unknown';

  // 记录是否存在（按 project=dialog:<id> + title 约定查找，否则新建）
  const dialogId = options.id || normalized.sample_id;
  let record = null;
  try {
    const catalog = loadCatalog(cfg);
    const found = catalog.records.find((item) => item.project === `dialog:${dialogId}`);
    if (found) record = loadRecord(cfg, found.id);
  } catch { /* 新库无 catalog */ }

  if (!record) {
    const { meta } = createRecord(cfg, {
      title: truncate(`对话记忆：${dialogId}（${speakers.join(' × ') || '未知参与者'}，${dateRange}）`, cfg.budgets.titleMax),
      gist: truncate(
        `${dialogId} 的完整对话记忆：${normalized.turns_total} 轮、${normalized.sessions.length} 个会话，`
        + `参与者 ${speakers.join('、') || '未知'}，时间跨度 ${dateRange}。事实见 facts 层，原文见 transcripts。`,
        cfg.budgets.gistMax,
      ),
      kind: 'episode',
      project: `dialog:${dialogId}`,
      aliases: [dialogId, `dialog-${dialogId}`],
      entities: speakers,
      tags: ['dialog', 'locomo', ...speakers.map((name) => slugify(name, 24))],
      key_points: [
        `参与者：${speakers.join('、')}`,
        `时间跨度：${dateRange}`,
        `会话数：${normalized.sessions.length}；轮次：${normalized.turns_total}`,
      ],
      workspace: options.workspace || cfg.defaultWorkspace,
      temperature: 'warm',
      standing: 'current',
      confidence: 0.9,
      disconfirmation: '当对话被证实与另一记录冲突或被用户撤回时，应取代本条。',
      created_by: options.created_by || 'dialog-ingest',
      scope: 'workspace',
    });
    record = loadRecord(cfg, meta.id);
  }

  const dir = record.dir;
  const existingFacts = loadFactsFromDir(dir);
  const meta = record.meta;
  if (existingFacts.length > 0 && meta.integrity?.facts_hash === sourceHash && !options.force) {
    return { id: meta.id, facts: existingFacts.length, reused: true, dir };
  }

  // L3：转写
  const transcriptsDir = path.join(dir, 'content', 'transcripts');
  ensureDir(transcriptsDir);
  for (const session of normalized.sessions) {
    const file = path.join(transcriptsDir, `${session.key}.txt`);
    const body = session.turns.map((turn) => `${turn.speaker}: ${turn.text}`).join('\n');
    fs.writeFileSync(file, `${session.date_raw}\n\n${body}\n`, 'utf8');
  }

  // facts：LLM 抽取（可用时）否则词面兜底
  const sem = semanticConfig(cfg);
  let facts = [];
  let extraction = 'fallback';
  if (sem.enabled && !options.noLlm) {
    const perSession = await mapWithConcurrency(normalized.sessions, sem.ingestConcurrency, async (session) => {
      try {
        return await extractFactsFromSession(cfg, {
          sessionKey: session.key,
          sessionDate: session.date_iso || session.date_raw,
          turns: session.turns,
        });
      } catch (error) {
        process.stderr.write(`[ingest] ${session.key} 抽取失败：${error.message}\n`);
        return null;
      }
    });
    for (let i = 0; i < normalized.sessions.length; i += 1) {
      const session = normalized.sessions[i];
      const extracted = perSession[i];
      if (!extracted) continue;
      for (const item of extracted) {
        facts.push(newFact({
          record_id: meta.id,
          session_key: session.key,
          turn_refs: [],
          statement: item.statement,
          turn_text: '',
          quote: item.quote || '',
          speakers: item.speakers.length ? item.speakers : speakersOfSession(session),
          entities: item.entities,
          date_iso: item.date_iso || session.date_iso,
          said_iso: session.date_iso,
          date_text: session.date_raw,
          kind: item.kind,
          confidence: 0.85,
        }));
      }
      extraction = 'llm';
    }
  }
  if (facts.length === 0) facts = fallbackFacts(normalized, meta.id);
  else if (sem.enabled && !options.noLlm) {
    // 跨会话 profile 归并：把散落多会话的属性（来自哪里、身份、家人、宠物、职业线）
    // 聚合成少量 profile 事实。这类事实任何单会话都拼不出来（如“4 年前从瑞典搬来”）。
    try {
      const { buildProfileFacts } = await import('./semantic.mjs');
      const profiles = await buildProfileFacts(cfg, meta.id, facts);
      for (const item of profiles) {
        facts.push(newFact({
          record_id: meta.id,
          session_key: 'profile',
          turn_refs: [],
          statement: item.statement,
          turn_text: '',
          quote: '',
          speakers: item.speakers,
          entities: item.entities,
          date_iso: item.date_iso || null,
          said_iso: dates[dates.length - 1] ?? null,
          date_text: '',
          kind: 'profile',
          confidence: 0.75,
        }));
      }
      if (profiles.length > 0) extraction += `+profile${profiles.length}`;
    } catch (error) {
      process.stderr.write(`[ingest] profile 归并失败（忽略）：${error.message}\n`);
    }
  }
  saveFactsToDir(dir, facts);
  invalidateFactCache(dir);

  // L2：登记 transcripts 与 facts
  const index = record.index;
  index.categories.notes = index.categories.notes ?? [];
  index.categories.notes = index.categories.notes.filter(
    (note) => !String(note?.path || '').includes('content/facts/facts.jsonl'),
  );
  index.categories.notes.push({
    path: 'content/facts/facts.jsonl',
    summary: `${facts.length} atomic facts (extraction=${extraction})`,
    captured_at: new Date().toISOString(),
  });
  writeJson(path.join(dir, 'index.json'), index);

  // L1：digest
  const sessionLines = normalized.sessions.map((session) => {
    const factN = facts.filter((fact) => fact.session_key === session.key).length;
    return `- ${session.key} · ${session.date_raw || 'unknown date'} · ${session.turns.length} 轮 · ${factN} facts`;
  });
  const digest = [
    `# ${meta.title}`,
    '',
    `> ${meta.gist}`,
    '',
    '## 1. 背景与目标',
    '',
    `由 dialog-ingest 摄入的多会话对话（${dialogId}）。目标是支撑跨会话问答：`,
    '事实层（facts.jsonl）供词面+语义召回；transcripts 保留原文供下钻。',
    '',
    '## 2. 时间线',
    '',
    ...sessionLines,
    '',
    '## 5. 当前状态',
    '',
    `- 事实抽取：${extraction}，共 ${facts.length} 条`,
    `- 源 hash：${sourceHash.slice(0, 16)}`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'digest.md'), digest, 'utf8');

  meta.integrity = meta.integrity ?? {};
  meta.integrity.facts_hash = sourceHash;
  meta.integrity.facts_count = facts.length;
  saveRecord(cfg, record, { event: 'dialog-ingested', note: `${facts.length} facts (${extraction})` });

  return { id: meta.id, facts: facts.length, reused: false, dir, extraction };
}

function speakersOfSession(session) {
  const set = new Set();
  for (const turn of session.turns) set.add(turn.speaker);
  return [...set];
}

// 便捷入口：从 JSON 文件摄入
export async function ingestDialogFromFile(cfg, file, options = {}) {
  const raw = fs.readFileSync(file, 'utf8');
  const dialog = JSON.parse(raw);
  return ingestDialog(cfg, dialog, options);
}
