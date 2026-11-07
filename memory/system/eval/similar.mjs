import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const lib = pathToFileURL(path.resolve(import.meta.dirname, '..', 'lib')).href;
const { loadConfig } = await import(`${lib}/store.mjs`);
const { buildFtsIndex, indexFileFor } = await import(`${lib}/fts.mjs`);
const { similarRecords } = await import(`${lib}/related.mjs`);

const topics = [
  '缓存一致性', '分页游标', '结算幂等', '权限边界', '索引重建',
  '离线队列', '灰度发布', '回滚策略', '连接池', '超时重试',
  '审计日志', '多租户隔离', '数据迁移', '任务调度', '告警抑制',
  '冷启动', '热更新', '限流熔断', '会话恢复', '文件锁',
  '快照恢复', '消息去重', '批处理', '增量同步', '冲突解决',
  '权限缓存', '连接复用', '请求合并', '失败重试', '幂等键',
  '事务边界', '日志采样', '指标聚合', '容量预估', '降级开关',
  '资源回收', '状态机', '版本兼容', '灰度回滚', '数据校验',
];

const clauses = ['设计', '旧方案', '复盘', '决策', '实现记录', '问题分析'];

const now = new Date().toISOString();
const records = [];
const clusters = new Map();
for (let c = 0; c < 40; c += 1) {
  const topic = topics[c];
  const ids = [];
  for (let v = 0; v < 4; v += 1) {
    const id = `rec-20261026-${String(c).padStart(6, '0')}-${String(v).padStart(4, '0')}`;
    ids.push(id);
    records.push({
      id,
      kind: 'episode',
      title: `${topic} ${clauses[v]}`,
      gist: `${topic} 的方案与验收，变体 ${v}。`,
      key_points: [`${topic} 的边界`],
      aliases: [`${topic} 旧称 ${v}`],
      tags: [`cluster-${c}`, 'similar-eval'],
      entities: [topic],
      workspace: 'D:/DSH',
      project: `cluster-${c}`,
      scope: 'workspace',
      owner: 'agent',
      standing: 'current',
      temperature: 'warm',
      confidence: 0.8,
      created_at: now,
      updated_at: now,
      last_touched_at: now,
      review_state: 'reviewed',
      open_loops: [],
      decisions: [],
      relations: [],
      session_refs: [],
      privacy: { sensitive: false, injectable: true, redact: [] },
      dir: `records/2026/10/${id}`,
    });
  }
  clusters.set(c, ids);
}
for (let i = 0; i < 100; i += 1) {
  const topic = `无关主题${i}`;
  records.push({
    id: `rec-20261026-900000-${String(i).padStart(4, '0')}`,
    kind: 'episode',
    title: `${topic} 记录`,
    gist: `${topic} 的普通信息。`,
    key_points: [],
    aliases: [],
    tags: ['distractor'],
    entities: [topic],
    workspace: 'D:/DSH',
    project: 'distractor',
    scope: 'workspace',
    owner: 'agent',
    standing: 'current',
    temperature: 'warm',
    confidence: 0.8,
    created_at: now,
    updated_at: now,
    last_touched_at: now,
    review_state: 'reviewed',
    open_loops: [],
    decisions: [],
    relations: [],
    session_refs: [],
    privacy: { sensitive: false, injectable: true, redact: [] },
    dir: `records/2026/10/rec-20261026-900000-${String(i).padStart(4, '0')}`,
  });
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-similar-eval-'));
for (const dir of ['index', 'sessions', 'projection', 'records', 'views', 'cache', 'inbox', 'system']) {
  fs.mkdirSync(path.join(root, dir), { recursive: true });
}
fs.writeFileSync(path.join(root, 'index', 'sessions.json'), JSON.stringify({ schema: 1, sessions: [] }));
fs.writeFileSync(path.join(root, 'ledger.json'), JSON.stringify({ schema: 1, entries: [] }));
const catalogPath = path.join(root, 'index', 'catalog.json');
fs.writeFileSync(catalogPath, JSON.stringify({ schema: 1, counts: { records: records.length }, records }));
const cfg = loadConfig({ root, sessionsRoot: path.join(root, 'sessions'), projectionRoot: path.join(root, 'projection') });
buildFtsIndex(records, indexFileFor(cfg), { catalogPath });

function evaluate(minCoverage) {
  let hit1 = 0;
  let hit5 = 0;
  let precision = 0;
  let returned = 0;
  for (let c = 0; c < 40; c += 1) {
    const result = similarRecords(cfg, {
      query: `${topics[c]} 的新问题`,
      k: 5,
      minCoverage,
    });
    const ids = result.results.map((item) => item.id);
    hit1 += ids[0] === clusters.get(c)[0] || clusters.get(c).includes(ids[0]) ? 1 : 0;
    hit5 += ids.some((id) => clusters.get(c).includes(id)) ? 1 : 0;
    const good = ids.filter((id) => clusters.get(c).includes(id)).length;
    precision += ids.length ? good / ids.length : 0;
    returned += ids.length;
  }
  let falsePositiveQueries = 0;
  for (let i = 0; i < 20; i += 1) {
    const result = similarRecords(cfg, { query: `完全未记录的主题 XYZ-${i}`, k: 5, minCoverage });
    if (result.results.length > 0) falsePositiveQueries += 1;
  }
  return {
    minCoverage,
    hit1: +(hit1 / 40).toFixed(3),
    hit5: +(hit5 / 40).toFixed(3),
    precisionAt5: +(precision / 40).toFixed(3),
    avgReturned: +(returned / 40).toFixed(2),
    falsePositiveQueries: `${falsePositiveQueries}/20`,
  };
}

const result = [0, 0.3, 0.5, 0.7, 0.9].map(evaluate);
fs.rmSync(root, { recursive: true, force: true });
console.log(JSON.stringify(result, null, 2));
