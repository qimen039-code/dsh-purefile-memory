# 工具调用/上下文降耗 · GitHub 调研结论（2026-11-04，子代理穷尽式检索）

## 同一长会话内降耗 TOP5（按可移植性）

| # | 方案 | 代表项目 | 机制 | 降耗幅度 |
|---|---|---|---|---|
| 1 | 工具结果落盘+指针替换+按需回读 | mksglu/context-mode (33.4k★)、ctx-zip、pi-context-prune | 输出进 SQLite FTS5/文件，上下文只留指针，agent 按需检索 | 80-99% |
| 2 | microcompact（旧工具结果逐条打分淘汰） | claude-code 内建 (154.5k★) / fast-jev-compaction (7.8k★) | 旧工具结果替换为摘要，保留最近 K 条 | 官方验证 |
| 3 | 后台预压缩代理 | Compresr/Context-Gateway (647★) | API 代理层 75% 阈值预压缩历史，零等待 | 压缩耗时移出关键路径 |
| 4 | Letta 分页记忆块 | letta-ai/letta (25.3k★) | core memory 常驻+archive 外置+sleep-time 整理 | 需改 harness |
| 5 | LLMLingua-2 批量压缩 | microsoft/LLMLingua (6.8k★) | 小模型令牌分类压 prompt 2-20x | 需本地小模型 |

跨会话记忆类（mem0 68.4k★ / graphiti 32.5k★ / cognee 33.1k★ / basic-memory 4.5k★ / langmem）：
解决"跨会话找回"，不解决"同一会话内"降耗。basic-memory 的「Markdown 文件即记忆 + wikilink 图谱 +
渐进式工具发现」与我们的 mem 设计最接近。

## 移植决策（针对 mem CLI + ZCode 环境）

**首选已采纳**：工具结果落盘+指针回读 —— 与 mem 的 L0/L1/route 天然同构。
已实现：`mem stow --file`（>10KB 输出 → reference 记录，上下文只留 id+gist）
        `mem turn --note`（每轮要点落盘 turns/YYYYMMDD.jsonl，同内容去重）
        全局 AGENTS.md「记忆循环」条款（每轮强制）。
**待做**：PostToolUse hook 自动把 >10KB 工具结果 stow（替代 agent 自觉调用）。
**拒绝引入**：mem0/graphiti/cognee（需向量/图库，违背纯文件约束）；LLMLingua（仅固定大文档压缩时选配）。
**零成本可抄**：basic-memory 的工具行为提示标签 + 渐进式工具发现。

## 2026-11-07 周期扫描（子代理原文核实版 → 详见 [SCAN_2026-11-07.md](SCAN_2026-11-07.md)）

| 档 | 条目 |
|---|---|
| 立即采纳 | ①2609.08258 补充：standing 过滤须在排序之前 + Memory-Rebirth-Attack 九场景改造入 chaos；②2604.16548 VMG 自审清单（重点补 Forget&Rollback 回滚工具）；③basic-memory v1.0.0 工程卫生（报告式 doctor + 解析加固） |
| 排队 | 2611.02912 `depends_on` 级联软撤销（facts v3.2）；2611.07631 MEMOIR 拆开（回顾性归因近零成本先上，门控合并不上）；2605.12493 LongMemEval-V2 抽样（换代评测主锚点，context-gathering 与 DSH recall 同形）；2611.01718 used-rate 使用点指标；cognee 冲突审查队列（conflicts.jsonl） |
| 观察 | 2611.03743 `validity_scope` 字段候选 + prompt 模式；2602.16313 评测轴迁移结论；2611.05731 前瞻记忆（主线收口后再议）；2608.28978 图式实证校准 assocExpand |
| 拒绝 | 2604.20300 遗忘曲线（与审计链可回溯伦理冲突，膨胀用冷层归档替代）；2611.05636 权重记忆（违反本地 4B 不训练约束） |
| 方向性 | 纯文件路线获 LongMemEval-V2 最优方法（AgentRunbook-C 72.5%＝轨迹存文件+agent 收集证据）背书；11 月三篇独立工作收敛"事实+状态"（validity_scope/depends_on 是自然延伸非转向）；评测轴迁移：LoCoMo 降级回归测试 + LongMemEval-V2 抽样 + used-rate + 级联撤销 chaos |

核实声明：9 论文 + 8 项目经原文/Releases API 核实；仅摘要级来源已降级；star 数来源矛盾不采信；"standing" 为 DSH 对 2609.08258 guard 思想的自命名（摘要页无此词）。
