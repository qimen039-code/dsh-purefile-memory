# 设计核对：早期预期 vs 当前实现（2026-10-31，依据会话 b2dbae8c 全部 17 条用户需求）

核对方法：逐条对照会话原始需求与 `memory/` 当前代码行为，标注【达成/部分/偏离】与证据。

## A. 核心架构（用户消息 #1）

| # | 早期预期 | 当前实现 | 状态 | 证据 |
|---|---|---|---|---|
| A1 | 最高效召回 + 精准存储 + 可读性 | L0-L3 四层 + facts 层 + FTS/词面/语义三级召回 | 达成 | dev 0.896（54 题本地口径）；召回 1-2ms 基线 |
| A2 | 活期/封存记忆区分，封存不污染活期 | temperature(hot/warm/sealed/frozen) + brief 只注入 hot/warm | 达成 | SYSTEM.md §1；recall 默认排除 frozen |
| A3 | 四层封存：元摘要/提炼/索引/分类内容 | meta.json/digest.md/index.json/content/ 出生即有 | 达成 | createRecord 固定层 |
| A4 | 纯脚本路由跳转连接器（按元摘要字段路由） | `mem route` + `mem://` URI | 达成 | cli.mjs cmdRoute |
| A5 | 衔枝思想：新结论推翻旧结论的写入标准 | supersede（新记录+双向链）/annotate（修正追加）/正文不改 | 达成 | store.mjs supersedeRecord |
| A6 | ACCF 优秀思想适当合并 | 仅吸收 owner 三分等字段语义；**框架本体已按 2026-10-29 指令摘除**（recall.includeLedger=false） | 达成（已纠偏） | recall.mjs 注释与 config |
| A7 | 存储规矩一开始定死，不后期搬运 | 记录出生即最终路径；ingest 幂等（facts_hash） | 达成 | dialog.mjs |
| A8 | 适配不断变化的 harness | 适配器隔离（sessions.mjs）；canonical 为普通文件；派生索引可重建 | 达成 | SYSTEM.md §11 |
| A9 | 何时写入/更新记忆（最重要功能） | 事件驱动写入表（SYSTEM.md §5）+ dialog-ingest 幂等缓存 | 达成 | SYSTEM.md §5 |
| A10 | brief 注入与上下文不冲突不重复 | brief 按 session hash 去重，delta 注入 | 达成 | recall.mjs brief() |
| A11 | 任意会话 @ 读取（跨工作区） | sessions 层 + `mem session show/context/find` | 达成 | sessions.mjs（ZCode 侧以文件路径等价使用） |

## B. 工程纪律（用户消息 #11/#12/#13，2026-10-29 再次强调）

| # | 预期 | 当前实现 | 状态 |
|---|---|---|---|
| B1 | 每加一个能力：测试 + 消融，奥卡姆剃刀去留 | dev 每轮跑；**缺口：v6 的 digest/扩展/profile 三件套没有单独消融**（一起上的） | 部分 → 本轮补消融 |
| B2 | 结构化最佳配比，不是大杂烩 | facts 层结构化（statement/speakers/date/kind）；rerank 单调用双任务 | 达成 |
| B3 | 没有参考时从自身问题第一性原理推导 | 123 道失分题逐题归因（bench/results/v4-failures.txt） | 达成 |
| B4 | 实验证实收益才保留，否则剔除 | 已有先例：premiseNote 实测无效→默认关；**本轮对 digest/扩展/assoc 逐项消融** | 执行中 |

## C. 新增需求（2026-10-31 用户指令）：记忆联想能力

| 预期 | 实现（本轮） | 消融口径 |
|---|---|---|
| 模型在这套记忆系统下获得记忆联想 | 确定性事实关联图（无 LLM）：共享实体/说话人的事实互为关联；召回时词面候选 → 关联扩展 → 重排看全簇 → digest 整合 | dev 开/关 assocExpand 对比；枚举/多跳题专项对比 |

## D. 与 A 系列的一致性检查（防偏离）

1. facts 层不设 temperature 过滤——封存记录的事实仍可召回。判定：符合 A2 本意（封存=元摘要随时可读+分层可下钻），facts 属于 L3 邻接层的派生可召回内容，且记录 L0 卡与召回结果并列呈现，未污染活期（不进 brief）。**保留**。
2. digest 注入答案候选——digest 是存量事实的忠实整合（prompt 级禁止发明），属于"提炼层"等价物，非编造。**保留，但保留 B4 消融权**。
3. ACCF 纠偏语义（contested/counter_evidence/再提门槛）——已全部不在召回链路。**维持摘除**。

## E. 已知真实收益清单（有实验数据支撑）

- 事实层（speakers/date/kind 锚定）：dev 0.285→0.689（修复 record_id 过滤后）。
- 弃答逻辑反转（只在零候选时弃答）：cat5 由误弃答 0.2 分翻正。
- digest（重排+整合合并调用）：dev 0.859→0.896，adversarial 1.00。
- 强制日期解析：temporal 类 gold 命中显著上升（dev6 temporal 0.85→日期口径统一）。
- 本地化（Qwen3-4B nf4）：零 API 成本，可无限消融。
