const PROJECTS = [
  'Orion', 'Lumen', 'Atlas', 'Nova', 'Delta', 'Aster', 'Cobalt', 'Mica',
  'Vela', 'Ridge', 'Sable', 'Ember', 'Fable', 'Grove', 'Harbor', 'Iris',
  'Juno', 'Kite', 'Loom', 'Nadir',
];

const TOPICS = [
  '缓存一致性', '分页游标', '结算幂等', '权限边界', '索引重建',
  '离线队列', '灰度发布', '回滚策略', '连接池', '超时重试',
  '审计日志', '多租户隔离', '数据迁移', '任务调度', '告警抑制',
  '冷启动', '热更新', '限流熔断', '会话恢复', '文件锁',
];

const BASE = Date.parse('2026-10-01T08:00:00.000Z');

function iso(offsetHours) {
  return new Date(BASE + offsetHours * 3600_000).toISOString();
}

function makeRecord(i) {
  const project = PROJECTS[i % PROJECTS.length];
  const topic = TOPICS[Math.floor(i / PROJECTS.length) % TOPICS.length];
  const standing = i % 13 === 0 ? 'superseded' : 'current';
  const temperature = i % 17 === 0 ? 'sealed' : i % 5 === 0 ? 'warm' : 'hot';
  const workspace = i % 10 === 0 ? 'D:/OTHER' : 'D:/DSH';
  return {
    id: `rec-20261001-000000-${i.toString(16).padStart(6, '0')}`,
    kind: i % 7 === 0 ? 'project' : 'episode',
    title: `${project} ${topic} 记录 ${i}`,
    aliases: [`${project} ${topic} 旧称 ${i}`],
    gist: `${project} 的 ${topic} 方案 ${i}，编号 ${project}-${i}，包含实现与验收信息。`,
    key_points: [`验收 ${topic} 的边界 ${i}`, `模块 ${project} 的约束 ${i}`],
    tags: [project.toLowerCase(), `topic-${i % TOPICS.length}`, 'eval'],
    entities: [project, topic],
    workspace,
    project,
    scope: 'workspace',
    owner: 'agent',
    standing,
    temperature,
    confidence: Number((0.55 + (i % 40) / 100).toFixed(2)),
    created_at: iso(i),
    updated_at: iso(i),
    last_touched_at: iso(i),
    review_state: 'reviewed',
    open_loops: [],
    decisions: [],
    relations: [],
    session_refs: [],
    privacy: { sensitive: false, injectable: true, redact: [] },
    dir: `records/2026/10/rec-20261001-000000-${i.toString(16).padStart(6, '0')}`,
  };
}

export function makeDataset(n = 1000) {
  const records = Array.from({ length: n }, (_, i) => makeRecord(i));
  const targets = [];
  const pick = (index) => {
    const record = records[index];
    return record.standing === 'current' && record.workspace === 'D:/DSH' ? index : pick(index + 1);
  };

  for (let i = 1; i <= 10; i += 1) {
    const index = pick(i * 31);
    targets.push({ category: 'title', query: records[index].title, want: records[index].id });
  }
  for (let i = 1; i <= 10; i += 1) {
    const index = pick(i * 43);
    targets.push({ category: 'code', query: records[index].gist.match(/\b[A-Za-z]+-\d+\b/)[0], want: records[index].id });
  }
  for (let i = 1; i <= 10; i += 1) {
    const index = pick(i * 47);
    targets.push({ category: 'alias', query: records[index].aliases[0], want: records[index].id });
  }
  for (let i = 1; i <= 10; i += 1) {
    const index = pick(i * 53);
    const record = records[index];
    targets.push({ category: 'topic', query: `${record.project} ${record.entities[1]}`, want: record.id });
  }
  for (let i = 1; i <= 5; i += 1) {
    const index = records.findIndex((record, j) => j > i * 61 && record.temperature === 'sealed' && record.workspace === 'D:/DSH');
    targets.push({ category: 'sealed', query: records[index].title, want: records[index].id });
  }
  for (let i = 1; i <= 5; i += 1) {
    const index = pick(700 + i * 11);
    const record = records[index];
    targets.push({ category: 'multi', query: `${record.entities[1]} ${record.key_points[0]}`, want: record.id });
  }
  return { records, queries: targets };
}

export function makeScaleDataset(n) {
  return Array.from({ length: n }, (_, i) => makeRecord(i));
}
