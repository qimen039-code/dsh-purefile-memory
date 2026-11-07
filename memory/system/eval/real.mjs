import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const lib = pathToFileURL(path.resolve(import.meta.dirname, '..', 'lib')).href;
const { loadConfig } = await import(`${lib}/store.mjs`);
const { recall } = await import(`${lib}/recall.mjs`);
const cfg = loadConfig();

const cases = [
  ['ACCF 隔离', 'rec-20261026-181458-3504'],
  ['WorkBuddy 自动写入', 'rec-20261026-181458-3504'],
  ['官方版 0.2.1-rc.3 卸载社区版', 'rec-20261026-181458-3504'],
  ['分层 四层 封存', 'rec-20261026-181541-6e67'],
  ['brief 去重 注入', 'rec-20261026-181541-6e67'],
  ['跨项目 会话 读取', 'rec-20261026-181541-6e67'],
  ['封存不搬目录', 'rec-20261026-181541-6e67'],
  ['官方 read grep 路由', 'rec-20261026-181541-6e67'],
  ['上次把旧版删掉又装回官方', 'rec-20261026-181458-3504'],
  ['怎么防止旧结论压住新任务', 'rec-20261026-181541-6e67'],
  ['卸载旧 DSH 插件并恢复官方', 'session-441ffb80-8a18-4120-ba81-8c53729d2f3b'],
  ['分层活期封存记忆系统设计', 'session-b2dbae8c-c167-447e-9e3b-3512a9565a78'],
  ['QQ 接入开源宠物项目调研', 'session-7d130d07-6546-468c-8d17-67ef311992c5'],
  ['评估 gpu-unlock-ada 项目风险', 'rec-20261026-225803-3f2c'],
  ['寻找节省 token 的 DSH 插件', 'rec-20261026-225803-056e'],
  ['A/B 实验推全后 CTR 衰减', 'rec-20261026-230702-2924'],
  ['社区版 官方签名', 'rec-20261026-181458-3504'],
  ['记忆契约 v2 disconfirmation', 'rec-20261026-181458-3504'],
  ['四层封存 audit', 'rec-20261026-181541-6e67'],
  ['L0 L1 L2 L3', 'rec-20261026-181541-6e67'],
  ['brief delta 去重', 'rec-20261026-181541-6e67'],
  ['session reference @', 'rec-20261026-181541-6e67'],
  ['whale widget 小鲸鱼', 'session-441ffb80-8a18-4120-ba81-8c53729d2f3b'],
  ['ACCF 13 工具', 'rec-20261026-181458-3504'],
  ['WorkBuddy 共用目录', 'rec-20261026-181458-3504'],
  ['Reasoning 状态', 'session-b2dbae8c-c167-447e-9e3b-3512a9565a78'],
  ['Twig 衔枝 叙事记忆', 'rec-20261026-181458-3504'],
  ['QQ 宠物 开源项目', 'session-7d130d07-6546-468c-8d17-67ef311992c5'],
  ['token 优化 插件', 'rec-20261026-225803-056e'],
  ['gpu-unlock-ada 风险', 'rec-20261026-225803-3f2c'],
];

function run(useIndex) {
  const rows = [];
  for (const [query, want] of cases) {
    const result = recall(cfg, { query, k: 10, workspace: 'D:/DSH', useIndex });
    const ids = result.results.map((item) => item.id);
    rows.push({ query, want, rank: ids.indexOf(want) + 1, ids });
  }
  const top1 = rows.filter((row) => row.rank === 1).length / rows.length;
  const top3 = rows.filter((row) => row.rank >= 1 && row.rank <= 3).length / rows.length;
  const mrr = rows.reduce((sum, row) => sum + (row.rank > 0 ? 1 / row.rank : 0), 0) / rows.length;
  return {
    mode: useIndex ? 'fts' : 'baseline',
    top1: +top1.toFixed(3),
    top3: +top3.toFixed(3),
    mrr: +mrr.toFixed(3),
    rows,
  };
}

const result = { cases: cases.length, baseline: run(false), fts: run(true) };
fs.writeFileSync(path.join(import.meta.dirname, 'real-latest.json'), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({
  cases: result.cases,
  baseline: { top1: result.baseline.top1, top3: result.baseline.top3, mrr: result.baseline.mrr },
  fts: { top1: result.fts.top1, top3: result.fts.top3, mrr: result.fts.mrr },
  differences: result.fts.rows.filter((row, i) => row.rank !== result.baseline.rows[i].rank).length,
}, null, 2));
