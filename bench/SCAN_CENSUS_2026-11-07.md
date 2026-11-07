# 记忆系统三个月全量普查·合并摘要（2026-11-07）

> 三路独立普查（arXiv 全量 / GitHub 全量 / 基准·工业·社区），全部可审计口径。
> 本文件是合并决策摘要；各路完整报告见会话存档与 mem stow。

## 一、覆盖率声明

| 路 | 方法 | 覆盖 |
|---|---|---|
| arXiv | export.arxiv.org API，19 个查询全部翻页取尽（含 submittedDate 日期过滤 5 路 + 短语查询 14 路）；两次独立运行计数一致 | 窗口（2026-08-07~11-07）去重 **2355 条**；相关约 **477 条**（高 298 / 中 118 / 低 61）；已知 17 编号 id_list 全部核验命中 |
| GitHub | Search API 14 组查询翻页取尽（fork:false 排序翻尽），33 个已知项目逐一 repos/releases API 核实 | 窗口内新建原始 ~2.6 万仓，≥5★ 段穷举收录；≥100★ 新项目 89 个全列 |
| 基准/工业/社区 | 26 轮中英文检索 + 4 关键站点 WebFetch 核验（LongMemEval-V2 repo / MemoryArena / PALM / AML） | 基准 12+、工业 12、产品 3、社区批评 10+ |

不确定项合并：arXiv 11-06/07 边缘未全入索引（计数略低）；宽泛查询混入 ~1400 条硬件类 memory（已按桶声明）；GitHub star 为单时点快照、DSH 插件群星数有互刷嫌疑已标注；BEAM/StateMemBench 等个别编号未能 id_list 核验的已注明仅摘要级。

## 二、arXiv 普查核心结果

**月度分布**：8月 514 → 9月 815 → 10月 883 → 11月前 5 日 143（走热，10 月峰值）。
**主题分布**：生命周期 22% / 评测 19% / 架构 20% / 检索混合 14% / 经验技能自进化 15% / **安全隐私攻击 13%** / 综述理论 2.5%。

**对 DSH 直接相关的关键条目（精选）**：
| 编号 | 主题 | 对 DSH 的含义 |
|---|---|---|
| 2608.19652 StateMemBench | 状态追踪评测 | 主流记忆系统对"当前状态"答对率仅 13-20%——facts 层的状态字段缺口是真实痛点 |
| 2611.02912 StateGraph | 级联撤销 | depends_on 派生链撤销，facts v3.2 候选 |
| 2611.03743 EvoMemState | 事实+状态收敛 | validity_scope（条件有效）字段候选 |
| 2611.01718 MemUse | 使用点评测 | used-rate 指标可直接实现（审计链已记录送达） |
| 2610.22668 | 相关≠充分 | 证据充分性（集合级）超越逐条相关性 |
| 2610.27406 More Memory, Worse Agents | **反持续** | 记忆复用放大错误；需要反持久机制——对"逐字全存"路线的针对性风险警示 |
| 2611.07554 The Memory Trap | 过泛化 | 良性记忆也会导致危险泛化 |
| 2610.17763 Memory Echo | 回声放大 | 重复写回放大历史主张；溯源缓解——审计链是天然资产 |
| 2611.05791 FlyHash | **非向量快速索引** | 果蝇式稀疏哈希替代稠密向量——纯文件约束内的"快速实时召回"可行路径 |
| 2609.05553 EdgeMem | LLM-free 超图记忆 | 免 LLM 的证据保持记忆——纯文件方向 |
| 2609.37474 Authority Before Utility | 撤销权威性 | 撤销后权威性>相关性——与 standing 过滤同向 |
| 2610.07100 When to Remember, When to Abstain | 类别条件弃答 | 弃答闸门（chaos 6/6 已验证）的进一步细化 |
| 2609.23315 Graph Memory At What Cost | 图记忆代价 | 图记忆查询/写入/更新系统级代价高——支持不引入图库 |
| 2610.38521 Memory Files Security | 文件篡改 | CLAUDE.md 类记忆文件被改的安全后果——本地文件即攻击面 |
| 2610.14431 MemForm | 写入投毒 | 记忆"形成"阶段投毒基准 |
| 2610.18052 Can Agents Forget When Asked | 遗忘基准 | 受测系统几乎全军覆没——standing 软撤销+审计回滚是差异化资产 |

## 三、GitHub 普查核心结果

**九条态势判断**（详见完整报告）：①纯文件/Markdown 记忆成新建项目第一范式（星榜前十约六成文件式）②DSH 生态 ~25 个记忆插件井喷（fish-memory 494★、meow-memory 376★ 等，全部本地文件式）③大厂密集入场（腾讯 Hy-Memory 3 周 1996★、火山 OpenViking 41737★、HF funes）④新范式「记忆基座模型」MemT-1.0 ⑤三匹存量黑马（hindsight 59614★、mempalace 60450★、ECC 298887★）⑥老牌全高频迭代（mem0 窗口 38 release、cognee 24、letta-agent-sdk 82）⑦harness 插件化成主分发渠道 ⑧评测治理层成型（AML 1115★、dolphinbench、OWASP Agent Memory Guard）⑨Memobase 事实性退场。

**对 DSH 直接相关的项目**：
- 同路线规范/格式：calpaterson/memoryfield-spec（模型无关记忆交换格式）、letta-ai/agent-file（.af）、okf-agent-memory（OKF v0.2）、Kerneta/daidocs（.dai 文本格式）
- 同路线引擎：basic-memory v1.0、EverOS（local-first Markdown-native）、memU、varun29ankuS/shodh-memory（LLM-free 本地 Rust）、tigerless-labs/agent-memory（4310★"Markdown 唯一真相源"）
- 社区反向移植旁证：lovezi0/dsh-memory-palace（把 WorkBuddy 式文件记忆移植进 DSH 生态）

## 四、基准/工业/社区普查核心结果

- **评测轴迁移成共识**：LoCoMo 退位（6.4% gold 错误审计 + 饱和 + Mem0 92.5/Zep 94.7 互不可信）；StateMemBench（窗口内新）状态追踪 13-20%；AML Leaderboard Cycle 2 结果 2026-11 中旬公布（统一 insert/search API，纯文件记忆可实现参赛）
- **最强外部背书**：Verging Labs 2176 任务 ×8 系统横评——agent 自维护的 plain markdown wiki **98.5 分胜全部商业产品**（blog 级证据，方法学有质疑）
- **工业同路线**：阿里 ReMe（Markdown 即记忆）、腾讯 Hy-Memory 2.0（MemHub 本地记忆应用）、MemOS memos-local-plugin、supermemory Local
- **Anthropic 三连改**：滚动摘要→多条目可编辑记忆——与本机「MEMORY.md 只留指针、内容在 mem」同构；其可见性倒退争议=本地方案「文件可读可改」优势的提醒
- **Mem0 自报**：LoCoMo 92.5 / LongMemEval 94.4（~6900 token/查询）——厂商自报，不可横比

## 五、合并信号清单（证据 → 对 DSH 的含义）

1. 纯文件路线获三层外部印证（顶会最优方法形态、工业同路线井喷、独立横评胜出）→ **方向不改**
2. 事实+状态收敛（3 篇独立 + StateMemBench 13-20%）→ facts 层补 `validity_scope`/`depends_on` 是证据最强的改进
3. 使用点评测兴起（MemUse/投递缺口/证据充分性）→ used-rate 指标近零成本可做
4. 反持续/回声/过泛化风险（3 篇独立）→ 需要记忆门控补强（本机已弃答闸门+逐字去重，缺"重复主张写回放大"的显式治理）
5. 安全面爆发（65 篇）→ 本地文件即攻击面；审计链+哈希账本是差异化资产，补完整性校验与写入门控
6. 图/向量路线的系统级代价被量化批评 → 不引入向量库/图库的决策**维持**，FlyHash 类稀疏哈希是纯文件约束内的可选加速路径（若将来需要）
7. 评测轴迁移 → LoCoMo 降级回归测试；自建状态探针 + used-rate + LongMemEval-V2 抽样 + AML 协议对齐
