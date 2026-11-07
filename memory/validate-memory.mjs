#!/usr/bin/env node
/**
 * DSH memory ledger validator.
 * Usage: node validate-memory.mjs [ledger.json]
 * Exit 1 when hard errors exist; warnings alone exit 0.
 */
import fs from 'node:fs';
import path from 'node:path';

const KINDS = new Set(['preference', 'fact', 'convention', 'protocol', 'claim', 'thread', 'handoff']);
const STATUSES = new Set(['candidate', 'active', 'contested', 'superseded', 'expired', 'archived']);
const SCOPES = new Set(['global', 'workspace']);
const OWNERS = new Set(['user', 'agent']);
const POLICY_EFFECTS = new Set(['none', 'check', 'ask', 'handoff']);
const EVIDENCE_TYPES = new Set(['session', 'file', 'command', 'url', 'user']);
const THREAD_STATUSES = new Set(['unresolved', 'resolved', 'dissolved', 'abandoned', 'superseded', 'merged']);
const PERSON_LABEL = /用户是|他就是|她就是|总是|从不|懒惰|抠门|不靠谱|拖延症|人格定性/;

const file = path.resolve(process.argv[2] ?? 'D:/DSH/memory/ledger.json');
const errors = [];
const warnings = [];
const fail = (id, message) => errors.push(`${id}: ${message}`);
const warn = (id, message) => warnings.push(`${id}: ${message}`);
const isDate = (value) => {
  if (typeof value !== 'string' || value.trim() === '') return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms);
};
const asArray = (value) => (Array.isArray(value) ? value : []);

let ledger;
try {
  ledger = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (error) {
  console.error(`无法读取/解析账本：${file}\n${error.message}`);
  process.exit(1);
}

if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) {
  console.error('账本根节点必须是对象。');
  process.exit(1);
}
if (ledger.version !== 1) fail('ledger', 'version 必须为 1');
if (!isDate(ledger.updated_at)) fail('ledger', 'updated_at 必须是 ISO 8601 时间');
if (!Array.isArray(ledger.entries)) fail('ledger', 'entries 必须是数组');

const entries = Array.isArray(ledger.entries) ? ledger.entries : [];
const byId = new Map();
const counts = { total: entries.length, active: 0, candidate: 0, contested: 0, superseded: 0, expired: 0, archived: 0 };
const kindCounts = {};

for (const [index, entry] of entries.entries()) {
  const id = typeof entry?.id === 'string' && entry.id ? entry.id : `#${index}`;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    fail(id, '条目必须是对象');
    continue;
  }
  if (byId.has(entry.id)) fail(id, 'id 重复');
  else if (typeof entry.id === 'string') byId.set(entry.id, entry);

  if (typeof entry.id !== 'string' || !/^mem-[0-9]{8}-[a-z0-9]+$/.test(entry.id)) {
    fail(id, 'id 必须形如 mem-YYYYMMDD-xxxx');
  }
  if (!KINDS.has(entry.kind)) fail(id, `kind 非法：${entry.kind}`);
  if (!STATUSES.has(entry.status)) fail(id, `status 非法：${entry.status}`);
  if (!SCOPES.has(entry.scope)) fail(id, `scope 非法：${entry.scope}`);
  if (entry.scope === 'workspace' && (typeof entry.workspace !== 'string' || entry.workspace.trim() === '')) {
    fail(id, 'scope=workspace 时必须写 workspace');
  }
  if (!OWNERS.has(entry.owner)) fail(id, `owner 非法：${entry.owner}`);
  for (const field of ['title', 'statement']) {
    if (typeof entry[field] !== 'string' || entry[field].trim() === '') fail(id, `${field} 不能为空`);
  }
  if (!Array.isArray(entry.applies_when)) fail(id, 'applies_when 必须是数组');
  if (!Array.isArray(entry.does_not_apply_when)) fail(id, 'does_not_apply_when 必须是数组');
  if (typeof entry.disconfirmation !== 'string') fail(id, 'disconfirmation 必须是字符串');
  if (typeof entry.confidence !== 'number' || entry.confidence < 0 || entry.confidence > 1) {
    fail(id, 'confidence 必须是 0–1 的数字');
  }
  if (!isDate(entry.created_at)) fail(id, 'created_at 必须是 ISO 8601 时间');
  if (!isDate(entry.last_verified_at)) fail(id, 'last_verified_at 必须是 ISO 8601 时间');
  if (entry.expires_at !== null && !isDate(entry.expires_at)) fail(id, 'expires_at 必须是 ISO 8601 时间或 null');
  if (entry.superseded_by !== null && typeof entry.superseded_by !== 'string') fail(id, 'superseded_by 必须是字符串或 null');
  if (entry.closure_reason !== null && typeof entry.closure_reason !== 'string') fail(id, 'closure_reason 必须是字符串或 null');
  if (!POLICY_EFFECTS.has(entry.policy_effect)) fail(id, `policy_effect 非法：${entry.policy_effect}`);
  if (!Number.isInteger(entry.priority) || entry.priority < 0 || entry.priority > 100) {
    fail(id, 'priority 必须是 0–100 的整数');
  }
  if (!Array.isArray(entry.tags)) fail(id, 'tags 必须是数组');
  if (typeof entry.endogenous !== 'boolean') fail(id, 'endogenous 必须是布尔值');

  if (!Array.isArray(entry.evidence)) {
    fail(id, 'evidence 必须是数组');
  } else {
    for (const [i, ev] of entry.evidence.entries()) {
      if (!ev || typeof ev !== 'object' || Array.isArray(ev)) {
        fail(id, `evidence[${i}] 必须是对象`);
        continue;
      }
      if (!EVIDENCE_TYPES.has(ev.type)) fail(id, `evidence[${i}].type 非法`);
      if (typeof ev.ref !== 'string' || ev.ref.trim() === '') fail(id, `evidence[${i}].ref 不能为空`);
      if (ev.note !== undefined && typeof ev.note !== 'string') fail(id, `evidence[${i}].note 必须是字符串`);
    }
  }

  if (entry.status === 'active') {
    counts.active += 1;
    if (!Array.isArray(entry.evidence) || entry.evidence.length === 0) fail(id, 'active 必须有至少一条 evidence');
    if (typeof entry.disconfirmation !== 'string' || entry.disconfirmation.trim() === '') {
      fail(id, 'active 必须有 disconfirmation（可证伪条件）');
    }
    if (!Array.isArray(entry.applies_when) || entry.applies_when.length === 0) {
      fail(id, 'active 必须至少有一条 applies_when');
    }
    if (typeof entry.confidence === 'number' && entry.confidence < 0.6) {
      fail(id, 'active 的 confidence 必须 >= 0.6；否则降为 candidate');
    }
    if (isDate(entry.expires_at) && Date.parse(entry.expires_at) <= Date.now()) {
      fail(id, 'active 但已过期；应改为 expired 或续期');
    }
    if (entry.scope === 'workspace' && (typeof entry.workspace !== 'string' || entry.workspace.trim() === '')) {
      fail(id, 'active workspace 记忆必须写 workspace');
    }
    if ((entry.kind === 'fact' || entry.kind === 'claim' || entry.kind === 'protocol') && entry.expires_at === null) {
      warn(id, `${entry.kind} 类 active 记忆建议设置 expires_at`);
    }
  } else if (entry.status === 'candidate') counts.candidate += 1;
  else if (entry.status === 'contested') {
    counts.contested += 1;
    if (typeof entry.closure_reason !== 'string' || entry.closure_reason.trim() === '') {
      warn(id, 'contested 建议在 closure_reason 写 user-vetoed 或原因');
    }
  } else if (entry.status === 'superseded') counts.superseded += 1;
  else if (entry.status === 'expired') counts.expired += 1;
  else if (entry.status === 'archived') counts.archived += 1;

  kindCounts[entry.kind] = (kindCounts[entry.kind] ?? 0) + 1;

  if (typeof entry.statement === 'string' && PERSON_LABEL.test(entry.statement)) {
    warn(id, '疑似人格定性；改成时间/项目/条件下的观察');
  }
  if (typeof entry.title === 'string' && PERSON_LABEL.test(entry.title)) {
    warn(id, '标题疑似人格定性');
  }

  if (entry.kind === 'thread') {
    if (typeof entry.open_question !== 'string' || entry.open_question.trim() === '') fail(id, 'thread 必须有 open_question');
    if (!THREAD_STATUSES.has(entry.thread_status)) fail(id, 'thread_status 非法');
    if (!entry.lineage || typeof entry.lineage !== 'object') fail(id, 'thread 必须有 lineage 对象');
    if (entry.thread_status && entry.thread_status !== 'unresolved') {
      if (typeof entry.closure_reason !== 'string' || entry.closure_reason.trim() === '') {
        fail(id, `thread_status=${entry.thread_status} 时必须写 closure_reason`);
      }
    }
    if (entry.thread_status === 'dissolved' && typeof entry.closure_reason === 'string' && entry.closure_reason.trim().length < 4) {
      warn(id, 'dissolved 的 closure_reason 应说明“为什么前提不再成立”');
    }
  }

  if (entry.kind === 'handoff') {
    for (const field of ['task_id', 'goal', 'stage', 'next_action']) {
      if (typeof entry[field] !== 'string' || entry[field].trim() === '') fail(id, `handoff 缺少 ${field}`);
    }
    if (!Array.isArray(entry.unknowns)) fail(id, 'handoff 的 unknowns 必须是数组');
  }

  if (entry.kind === 'protocol') {
    if (entry.status === 'active') {
      if (!Array.isArray(entry.context_tags) || entry.context_tags.length === 0) fail(id, 'active protocol 必须有 context_tags');
      if (!Array.isArray(entry.evidence_ids) || entry.evidence_ids.length === 0) fail(id, 'active protocol 必须有 evidence_ids');
    }
    if (typeof entry.statement === 'string' && /永远|总是|无论如何/.test(entry.statement)) {
      warn(id, 'protocol 出现了“永远/总是/无论如何”，请写清适用条件');
    }
  }

  if (Array.isArray(entry.supersedes)) {
    for (const oldId of entry.supersedes) {
      const old = byId.get(oldId);
      if (!old) {
        warn(id, `supersedes 指向不存在的 id：${oldId}`);
        continue;
      }
      if (old.status !== 'superseded') warn(id, `supersedes 目标 ${oldId} 的 status 不是 superseded`);
      if (old.superseded_by !== entry.id) warn(id, `supersedes 目标 ${oldId} 的 superseded_by 不是 ${entry.id}`);
    }
  }
}

for (const entry of entries) {
  if (entry && typeof entry === 'object' && typeof entry.superseded_by === 'string') {
    const target = byId.get(entry.superseded_by);
    if (!target) warn(entry.id ?? '?', `superseded_by 指向不存在的 id：${entry.superseded_by}`);
    else if (!Array.isArray(target.supersedes) || !target.supersedes.includes(entry.id)) {
      warn(entry.id ?? '?', `superseded_by ${entry.superseded_by} 的 supersedes 未包含本条`);
    }
  }
}

const active = entries.filter((e) => e && e.status === 'active');
const activeGlobal = active.filter((e) => e.scope === 'global').length;
const activeWorkspace = active.filter((e) => e.scope === 'workspace').length;
if (activeGlobal > 20) warn('ledger', `active global 有 ${activeGlobal} 条，超过 20 条预算`);
if (activeWorkspace > 20) warn('ledger', `active workspace 有 ${activeWorkspace} 条，超过 20 条预算`);
const activeChars = active.reduce((sum, e) => sum + String(e.title ?? '').length + String(e.statement ?? '').length, 0);
if (activeChars > 12000) warn('ledger', `active 文本总长约 ${activeChars} 字符，建议压缩或归档`);

console.log(`账本：${file}`);
console.log(`条目：${counts.total} | active ${counts.active}（global ${activeGlobal} / workspace ${activeWorkspace}）| candidate ${counts.candidate} | contested ${counts.contested} | superseded ${counts.superseded} | expired ${counts.expired} | archived ${counts.archived}`);
console.log(`类型：${Object.entries(kindCounts).map(([k, v]) => `${k} ${v}`).join(' | ') || '无'}`);
console.log(`active 文本量：约 ${activeChars} 字符`);

if (warnings.length > 0) {
  console.log(`\n警告（${warnings.length}）：`);
  for (const warning of warnings) console.log(`  ! ${warning}`);
}
if (errors.length > 0) {
  console.log(`\n错误（${errors.length}）：`);
  for (const error of errors) console.log(`  x ${error}`);
  process.exit(1);
}
console.log('\n校验通过。');
