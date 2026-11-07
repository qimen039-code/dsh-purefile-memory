import fs from 'node:fs';
import path from 'node:path';
import {
  MemError,
  boolFlag,
  daysSince,
  ensureDir,
  escapeCell,
  findZstd,
  flag,
  formatBytes,
  isoDay,
  nowIso,
  numberFlag,
  normKey,
  oneLine,
  parseDate,
  queryTerms,
  readJson,
  resolveInside,
  scoreFields,
  sha256File,
  shortHash,
  truncate,
  uniqueBy,
  workspaceKey,
  writeJson,
  zstdDecompress,
  zstdFirstFrame,
} from './util.mjs';
import { loadCatalog, rebuildCatalog, writeText } from './store.mjs';

const TRANSCRIPT_NAMES = ['session.v4.jsonl.zstd', 'session.jsonl.zstd'];

export function scanSessionDirs(cfg) {
  const found = [];
  let workspaces = [];
  try {
    workspaces = fs.readdirSync(cfg.sessionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(cfg.sessionsRoot, entry.name));
  } catch {
    return found;
  }
  for (const workspaceDir of workspaces) {
    let sessions = [];
    try {
      sessions = fs.readdirSync(workspaceDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('session-'))
        .map((entry) => path.join(workspaceDir, entry.name));
    } catch {
      continue;
    }
    for (const dir of sessions) {
      const transcript = TRANSCRIPT_NAMES
        .map((name) => path.join(dir, name))
        .find((file) => fs.existsSync(file));
      if (!transcript) continue;
      found.push({
        id: path.basename(dir),
        dir,
        transcript,
        format: path.basename(transcript).includes('.v4.') ? 'v4' : 'legacy',
      });
    }
  }
  found.sort((a, b) => String(b.transcript).localeCompare(String(a.transcript)));
  return found;
}

export function projectionPath(cfg, id) {
  return path.join(cfg.projectionRoot, `${id}.json`);
}

export function loadProjection(cfg, id) {
  return readJson(projectionPath(cfg, id), null);
}

function row(projection, key) {
  return projection?.record?.rows?.[key]?.val ?? null;
}

function identity(projection) {
  return projection?.record?.identity ?? null;
}

function isoFromMs(ms) {
  if (!ms) return null;
  const date = new Date(Number(ms));
  return Number.isFinite(date.getTime()) ? nowIso(date) : null;
}

export function hashFileCached(cfg, file) {
  const cacheFile = path.join(cfg.cacheDir, 'session-hashes.json');
  const cache = readJson(cacheFile, { files: {} });
  let stat;
  try { stat = fs.statSync(file); } catch { return ''; }
  const key = path.resolve(file);
  const existing = cache.files[key];
  if (existing && existing.size === stat.size && existing.mtimeMs === stat.mtimeMs) {
    return existing.sha256;
  }
  const sha256 = sha256File(file);
  cache.files[key] = { size: stat.size, mtimeMs: stat.mtimeMs, sha256, at: nowIso() };
  writeJson(cacheFile, cache);
  return sha256;
}

export function buildSessionCard(cfg, sessionDir, projection = null) {
  const id = sessionDir.id;
  const projectionRecord = projection ?? loadProjection(cfg, id);
  const ident = identity(projectionRecord) ?? {};
  const headerLine = zstdFirstFrame(sessionDir.transcript);
  let header = {};
  try { header = JSON.parse(headerLine); } catch { header = {}; }

  const cwd = ident.cwd || header.cwd || '';
  const workspace = cwd || cfg.defaultWorkspace;
  const createdAt = isoFromMs(ident.createdAt ?? header.createdAt) ?? nowIso();
  const outlineTurns = row(projectionRecord, 'turnOutline')?.turns ?? [];
  const stats = row(projectionRecord, 'sessionStats') ?? {};
  const lastPromptAt = row(projectionRecord, 'sessionListMetadata')?.lastPromptAt;
  const projectionMtime = fs.existsSync(projectionPath(cfg, id))
    ? fs.statSync(projectionPath(cfg, id)).mtimeMs
    : null;
  const transcriptMtime = fs.statSync(sessionDir.transcript).mtimeMs;
  const updated = isoFromMs(Math.max(
    Number(lastPromptAt) || 0,
    Number(projectionMtime) || 0,
    Number(transcriptMtime) || 0,
  )) ?? createdAt;

  const title = row(projectionRecord, 'title') || header.title || firstPromptFallback(cfg, sessionDir.transcript) || `会话 ${id.slice(-8)}`;
  const firstPrompt = outlineTurns[0]?.prompt
    || row(projectionRecord, 'titleInput')?.first?.text
    || '';
  const lastResponse = [...outlineTurns].reverse().find((turn) => turn.response)?.response || '';
  const gist = truncate(oneLine(`${title}${firstPrompt ? ` — ${firstPrompt}` : ''}`), cfg.budgets.gistMax);
  const keyPoints = outlineTurns.slice(0, 6).map((turn) => {
    const prompt = truncate(oneLine(turn.prompt || ''), 80);
    const response = truncate(oneLine(turn.response || ''), 90);
    return `${prompt}${response ? ` → ${response}` : ''}`;
  }).filter(Boolean);

  const cardPath = sessionCardPath(cfg, workspace, id);
  const previous = readJson(cardPath, null);
  const manual = previous?.manual ?? {};
  const tags = uniqueBy([
    'session',
    workspaceKey(workspace),
    ...(manual.tags ?? []),
  ].filter(Boolean), (item) => item);
  const transcriptSha = hashFileCached(cfg, sessionDir.transcript);

  return {
    schema: 1,
    id,
    short_id: id.replace(/^session-/, '').slice(0, 8),
    title,
    workspace,
    cwd,
    created_at: createdAt,
    updated_at: updated,
    turns: Math.max(outlineTurns.length, Number(stats.lastTurn) || 0),
    last_turn: Number(stats.lastTurn) || outlineTurns.length || 0,
    model: row(projectionRecord, 'modelSelection')?.lastUsed?.model ?? '',
    gist,
    key_points: keyPoints,
    tags,
    entities: manual.entities ?? [],
    open_loops: manual.open_loops ?? [],
    notes: manual.notes ?? '',
    related_records: manual.related_records ?? [],
    transcript: {
      path: sessionDir.transcript,
      format: sessionDir.format,
      bytes: fs.statSync(sessionDir.transcript).size,
      sha256: transcriptSha,
    },
    projection: {
      path: projectionPath(cfg, id),
      available: Boolean(projectionRecord),
    },
    manual,
  };
}

export function sessionCardPath(cfg, workspace, id) {
  return path.join(cfg.sessionsStore, workspaceKey(workspace), `${id}.json`);
}

export function writeSessionCard(cfg, card) {
  const file = sessionCardPath(cfg, card.workspace, card.id);
  writeJson(file, card);
  const mdFile = file.replace(/\.json$/, '.md');
  const points = (card.key_points ?? []).map((point) => `- ${point}`).join('\n') || '- （无）';
  const loops = (card.open_loops ?? []).length
    ? card.open_loops.map((loop) => `- ${loop.question}（${loop.status}）`).join('\n')
    : '- 无';
  writeText(mdFile, `# ${card.title}

> ${card.gist}

- id: \`${card.id}\`
- workspace: ${card.workspace}
- created: ${card.created_at}
- updated: ${card.updated_at}
- turns: ${card.turns}
- transcript: \`${card.transcript.path}\` (${formatBytes(card.transcript.bytes)})
- sha256: \`${card.transcript.sha256}\`

## 轮次摘要

${points}

## 未闭合

${loops}

## 原生引用

\`\`\`text
${sessionMention(card)}
\`\`\`

## 读取

\`\`\`text
mem session show ${card.id} --last 5
mem session context ${card.id}
\`\`\`
`);
  return { file, mdFile };
}

export function indexSessions(cfg, { force = false } = {}) {
  const sessionDirs = scanSessionDirs(cfg);
  const cards = [];
  const errors = [];
  for (const dir of sessionDirs) {
    try {
      const card = buildSessionCard(cfg, dir);
      cards.push(card);
      writeSessionCard(cfg, card);
    } catch (error) {
      errors.push({ session: dir.id, error: error.message });
    }
  }
  cards.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  writeJson(path.join(cfg.indexDir, 'sessions.json'), {
    schema: 1,
    generated_at: nowIso(),
    counts: { sessions: cards.length, workspaces: new Set(cards.map((card) => card.workspace)).size },
    errors,
    sessions: cards,
  });
  rebuildCatalog(cfg, { reason: 'sessions-indexed' });
  return { cards, errors, sessionDirs: sessionDirs.length };
}

export function loadSessions(cfg) {
  const data = readJson(path.join(cfg.indexDir, 'sessions.json'), null);
  if (!data || !Array.isArray(data.sessions)) {
    return indexSessions(cfg).cards;
  }
  return data.sessions;
}

export function resolveSession(cfg, ref) {
  const wanted = String(ref ?? '').trim();
  if (!wanted) throw new MemError('缺少 session id。', 'MISSING_SESSION_ID');
  const sessions = loadSessions(cfg);
  const exact = sessions.find((session) => session.id === wanted);
  if (exact) return exact;
  const byShort = sessions.filter((session) =>
    session.short_id === wanted || session.id.replace(/^session-/, '').startsWith(wanted));
  if (byShort.length === 1) return byShort[0];
  if (byShort.length > 1) {
    throw new MemError(`会话 id 前缀不唯一：${wanted}（${byShort.length} 个匹配）`, 'AMBIGUOUS_SESSION');
  }
  const byTitle = sessions.filter((session) =>
    String(session.title ?? '').toLowerCase().includes(wanted.toLowerCase()));
  if (byTitle.length === 1) return byTitle[0];
  throw new MemError(`找不到会话：${wanted}`, 'SESSION_NOT_FOUND');
}

export function sessionMention(card) {
  const label = String(card.title || card.id).replace(/[\[\]]/g, '');
  const encoded = Buffer.from(card.id, 'utf8').toString('base64url');
  return `@[${label}](dsh-session:${encoded})`;
}

function textOfContent(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

function firstPromptFallback(cfg, transcript) {
  try {
    const zstd = findZstd(cfg);
    if (!zstd) return '';
    const lines = zstdDecompress(transcript, zstd).split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type !== 'user/message') continue;
      if (event.data?.source?.kind && event.data.source.kind !== 'user') continue;
      const text = oneLine(textOfContent(event.data?.content));
      if (text) return truncate(text, 40);
    }
  } catch {
    return '';
  }
  return '';
}

function isRealUserMessage(data) {
  const kind = data?.source?.kind;
  if (!kind) return true;
  return kind === 'user';
}

export function parseSessionTranscript(cfg, card, { reasoning = false } = {}) {
  const zstd = findZstd(cfg);
  const text = zstdDecompress(card.transcript.path, zstd);
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  const turns = new Map();
  let header = null;
  let title = card.title;
  let currentTurn = 0;
  const artifacts = [];

  const ensureTurn = (turnNumber) => {
    const key = Number(turnNumber) || 0;
    if (!turns.has(key)) {
      turns.set(key, {
        turn: key,
        user: [],
        assistant: [],
        reasoning: [],
        tools: [],
        events: [],
        started_at: null,
        ended_at: null,
      });
    }
    return turns.get(key);
  };

  for (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'session') {
      header = event;
      continue;
    }
    if (event.type === 'session/title') {
      if (event.data?.title) title = event.data.title;
      continue;
    }
    if (event.type === 'turn/start') {
      currentTurn = Number(event.data?.turn) || currentTurn;
      const turn = ensureTurn(currentTurn);
      turn.started_at = isoFromMs(event.time);
      continue;
    }
    if (event.type === 'turn/end') {
      const turn = ensureTurn(event.data?.turn ?? currentTurn);
      turn.ended_at = isoFromMs(event.time);
      if (event.data?.reason?.kind) turn.end_reason = event.data.reason.kind;
      continue;
    }
    if (event.type === 'user/message') {
      if (!isRealUserMessage(event.data)) continue;
      const turnNumber = Number(event.data?.turn ?? currentTurn) || currentTurn;
      const turn = ensureTurn(turnNumber);
      const body = textOfContent(event.data?.content);
      if (body.trim()) turn.user.push({ at: isoFromMs(event.time), text: body.trim() });
      continue;
    }
    if (event.type === 'assistant/message') {
      const turnNumber = Number(event.data?.turn ?? currentTurn) || currentTurn;
      const turn = ensureTurn(turnNumber);
      const body = textOfContent(event.data?.message?.content);
      if (body.trim()) turn.assistant.push({ at: isoFromMs(event.time), text: body.trim() });
      if (reasoning) {
        const reasoningText = (event.data?.message?.content ?? [])
          .filter((block) => block?.type === 'reasoning' && block.text)
          .map((block) => block.text)
          .join('\n');
        if (reasoningText.trim()) turn.reasoning.push(reasoningText.trim());
      }
      for (const block of event.data?.message?.content ?? []) {
        if (block?.type !== 'tool-call') continue;
        turn.tools.push({
          at: isoFromMs(event.time),
          name: block.name ?? block.toolName ?? 'tool',
          arguments: truncate(typeof block.arguments === 'string'
            ? block.arguments : JSON.stringify(block.arguments ?? ''), 1200),
          callId: block.callId ?? block.id ?? '',
          result: '',
        });
      }
      continue;
    }
    if (event.type === 'tool/result') {
      const callId = event.data?.toolCallId ?? event.data?.message?.toolCallId;
      const turnNumber = Number(event.data?.turn ?? currentTurn) || currentTurn;
      const turn = ensureTurn(turnNumber);
      const resultText = textOfContent(event.data?.message?.content) || '';
      const tool = [...turn.tools].reverse().find((item) => item.callId && item.callId === callId);
      if (tool) tool.result = truncate(resultText, 4000);
      continue;
    }
    if (event.type === 'workspace/changes' || event.type === 'deliverables/presented') {
      artifacts.push({ type: event.type, at: isoFromMs(event.time), data: event.data });
      continue;
    }
  }

  const sorted = [...turns.values()].sort((a, b) => a.turn - b.turn);
  return {
    id: card.id,
    title,
    workspace: card.workspace,
    cwd: card.cwd,
    created_at: card.created_at,
    updated_at: card.updated_at,
    header,
    turns: sorted,
    artifacts,
    events: lines.length,
  };
}

function selectTurns(parsed, options) {
  let turns = parsed.turns;
  const turn = numberFlag(options, 'turn', null);
  const last = numberFlag(options, 'last', null);
  const grep = flag(options, 'grep', null);
  if (turn) turns = turns.filter((item) => item.turn === turn);
  if (last) turns = turns.slice(-last);
  if (grep) {
    const needle = String(grep).toLowerCase();
    turns = turns.filter((item) => {
      const text = [
        ...item.user.map((entry) => entry.text),
        ...item.assistant.map((entry) => entry.text),
        ...item.tools.map((tool) => `${tool.name} ${tool.arguments} ${tool.result}`),
      ].join('\n').toLowerCase();
      return text.includes(needle);
    });
  }
  return turns;
}

function renderTurn(turn, { full = false, maxPartChars = 4000 } = {}) {
  const lines = [`## Turn ${turn.turn}`, ''];
  if (turn.started_at) lines.push(`_${turn.started_at}${turn.end_reason ? ` · ${turn.end_reason}` : ''}_`, '');
  for (const entry of turn.user) {
    lines.push('**User**', '', truncate(entry.text, maxPartChars), '');
  }
  for (const entry of turn.assistant) {
    lines.push('**Assistant**', '', truncate(entry.text, maxPartChars), '');
  }
  if (turn.tools.length > 0) {
    const toolLimit = full ? 30 : 12;
    lines.push(`**Tools** (${turn.tools.length}${turn.tools.length > toolLimit ? `, first ${toolLimit}` : ''})`, '');
    for (const tool of turn.tools.slice(0, toolLimit)) {
      lines.push(`- \`${tool.name}\` ${truncate(oneLine(tool.arguments), full ? 600 : 180)}`);
      if (full && tool.result) lines.push(`  - result: ${truncate(oneLine(tool.result), 600)}`);
    }
    if (turn.tools.length > toolLimit) lines.push(`- … 另有 ${turn.tools.length - toolLimit} 个工具调用（用 --full 看前 30 个）`);
    lines.push('');
  }
  if (full) {
    for (const entry of turn.reasoning) {
      lines.push('**Reasoning**', '', truncate(entry, 2000), '');
    }
  }
  return lines.join('\n');
}

export function showSession(cfg, ref, options = {}) {
  const card = resolveSession(cfg, ref);
  const parsed = parseSessionTranscript(cfg, card, { reasoning: boolFlag(options, 'reasoning', false) });
  const turns = selectTurns(parsed, options);
  const full = boolFlag(options, 'full', false);
  const maxChars = numberFlag(options, 'max-chars', cfg.budgets.sessionShowMaxChars)
    || cfg.budgets.sessionShowMaxChars;
  const maxPartChars = numberFlag(options, 'max-part', full ? 12000 : 4000);
  if (boolFlag(options, 'json', false)) {
    return { card, parsed: { ...parsed, turns } };
  }
  const lines = [
    `# ${parsed.title}`,
    '',
    `- session: \`${card.id}\``,
    `- workspace: ${card.workspace}`,
    `- time: ${card.created_at} → ${card.updated_at}`,
    `- turns: ${parsed.turns.length} shown ${turns.length} (total ${parsed.turns.length})`,
    `- transcript: \`${card.transcript.path}\``,
    `- native mention: \`${sessionMention(card)}\``,
    '',
  ];
  for (const turn of turns) lines.push(renderTurn(turn, { full, maxPartChars }));
  let output = lines.join('\n');
  if (output.length > maxChars) {
    output = `${output.slice(0, maxChars)}\n\n…（已按 max-chars=${maxChars} 截断；用 --turn/--last/--grep 精确读取）`;
  }
  return output;
}

export function sessionContext(cfg, ref, options = {}) {
  const card = resolveSession(cfg, ref);
  const parsed = parseSessionTranscript(cfg, card, { reasoning: false });
  const last = numberFlag(options, 'last', 3) || 3;
  const turns = parsed.turns.slice(-last);
  const catalog = loadCatalog(cfg);
  const related = catalog.records.filter((record) =>
    (record.relations ?? []).some((relation) => relation.target === card.id)
    || (record.session_refs ?? []).some((session) => session.id === card.id),
  );
  const lines = [
    `# 接续上下文：${card.title}`,
    '',
    `- session: \`${card.id}\``,
    `- workspace: ${card.workspace}`,
    `- updated: ${card.updated_at}`,
    `- summary: ${card.gist}`,
    '',
    '## 最近轮次',
    '',
  ];
  for (const turn of turns) lines.push(renderTurn(turn, { full: false, maxPartChars: 3000 }));
  if (card.open_loops.length) {
    lines.push('## 未闭合', '');
    for (const loop of card.open_loops) lines.push(`- ${loop.question}（${loop.status}）`);
    lines.push('');
  }
  if (related.length) {
    lines.push('## 关联记忆', '');
    for (const record of related.slice(0, 8)) {
      lines.push(`- \`${record.id}\` ${record.title} — ${record.gist}`);
    }
    lines.push('');
  }
  if (parsed.artifacts.length) {
    lines.push('## 产物/变更事件', '');
    for (const artifact of parsed.artifacts.slice(-8)) {
      lines.push(`- ${artifact.type} @ ${artifact.at || '?'}`);
    }
    lines.push('');
  }
  lines.push('## 继续', '', `\`mem session show ${card.id} --last 5\``, '');
  return lines.join('\n');
}

export function findSessions(cfg, query, { k = 8, workspace = null } = {}) {
  const sessions = loadSessions(cfg);
  const terms = queryTerms(query);
  const scored = sessions.map((session) => {
    const fields = [
      { text: String(session.title ?? '').toLowerCase(), weight: 8 },
      { text: String(session.gist ?? '').toLowerCase(), weight: 4 },
      { text: (session.key_points ?? []).join(' ').toLowerCase(), weight: 2 },
      { text: (session.tags ?? []).join(' ').toLowerCase(), weight: 3 },
      { text: (session.entities ?? []).join(' ').toLowerCase(), weight: 3 },
    ];
    const { score, reasons } = scoreFields(terms, fields);
    const workspaceBoost = workspace && normKey(session.workspace) === normKey(workspace) ? 2 : 0;
    return { session, score: score + workspaceBoost, reasons };
  }).filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
  return scored;
}

export function sessionStats(cfg) {
  const sessions = loadSessions(cfg);
  return {
    sessions: sessions.length,
    workspaces: new Set(sessions.map((session) => session.workspace)).size,
    newest: sessions[0]?.updated_at ?? null,
    oldest: sessions[sessions.length - 1]?.updated_at ?? null,
  };
}

export function sessionCardLinks(cfg, card) {
  return {
    json: sessionCardPath(cfg, card.workspace, card.id),
    md: sessionCardPath(cfg, card.workspace, card.id).replace(/\.json$/, '.md'),
    mention: sessionMention(card),
  };
}
