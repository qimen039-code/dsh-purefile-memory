# 研究迭代路线图（RESEARCH_ROADMAP）

> 维护纪律：每个阶段结束时更新本文件（用户 2026-11-08 指令）。记录：做过什么、结论、实验结果、要求及其演变、被推翻的要求/结论、推进过程、外部资料（含来源）、有效结论与数据。
> 当前总目标（2026-11-08 修订）：**混合基准（LoCoMo 回归 + 新基准指标 + 模型无关性矩阵 + 轮换防过拟合内容）达到 ≥0.9，保底 ≥0.85**。

## 1. 总目标演进时间线

| 日期 | 阶段 | 目标/动作 | 结果 |
|---|---|---|---|
| 2026-10 中 | ACCF 时代 | agent-cognitive-continuity-framework（含向量混合召回、ACCF_NO_VECTOR 开关） | **失败实验**（README 已声明勿部署；其向量路线被后继系统取代） |
| 2026-10-28 | DSH 记忆系统部署 + LoCoMo 审计 | 部署纯文件四层记忆（v3）；审计旧跑分 | 旧跑分不可信（harness 静默失败）；审计出词面打分 4 根因 + judge 噪声 + cat5 口径问题；REPORT.md 交付 |
| 2026-10-28~11-04 | v3.1 迭代 | 事实层/语义重排/抽取保真/弃答闸门 | 全量 0.357→0.687（旧协议）；full-context 基线 ≈0.68；**0.9 在旧口径下结构性不可达** |
| 2026-11-04 | 三层记忆调度定案 | DSH mem CLI = 唯一权威外置记忆；ZCode 原生记忆降为指针 | 用户指令固化于全局 AGENTS.md |
| 2026-11-07 早 | 本地全量重跑启动 | 单模型（本地 Qwen3-4B）全新 294 题（v10） | 过程故障多（详见 §5），最终完成 |
| 2026-11-07 09:10 | 用户要求文献周期扫描 + Git 提交 | /workflow 指令 | 单次扫描完成；**周期机制当日已补建（每周一 10:00 automation-23756db0）** |
| 2026-11-07 晚 | 会话审计 + 修复 | 用户指出上会话幻觉/推送未达/调研未做 | 审计还原真相：门禁误报（扫描器缓冲故障）+ github.com:443 被墙双层卡点；Git Data API 逐字节复刻推送成功；mem CLI 注册 agenttools 总线 |
| 2026-11-07 晚 | 独立仓库发布 | 新建 dsh-purefile-memory（公开，MIT） | 隐私红线执行（运行时数据排除、敏感串清洗零命中、Mimosa 深扫 0 发现）；README 规范版 + 一键安装脚本 + 非成品声明 |
| 2026-11-07 夜 | **三个月全量普查**（用户指令：有多少查多少，非抽样） | arXiv 2355 条穷举 / GitHub 2.6 万仓 ≥5★ 穷举 / 基准工业 26 轮核验 | 三路报告完成（SCAN_CENSUS_2026-11-07.md）；LoCoMo 退位共识、纯文件路线获三层外部印证、评测轴迁移 |
| 2026-11-07 夜 | 设计评估 + 改进方案评估 | 用户指令 | DESIGN_EVALUATION_2026-11-07.md：B/A/C/D/F 五项证据强改进，全部纯文件内可行；向量化议题→FlyHash 类纯文件替代路径列为观察 |
| 2026-11-08 | **合并评测标准启动**（用户指令） | LoCoMo 降为回归项之一；新基准指标 + 模型无关性矩阵合并出分 | v10 回归 0.8463；重判 0.844；recall@k 0.329；used-rate 0.423；弃答正确率 0.527；五模型矩阵过夜运行 |
| 2026-11-08 | **轮换防过拟合条件加入**（用户指令） | 题目/语料经常轮换（打乱/拟造/收集同型不同文），确保收益来自记忆系统而非同类题反复迭代 | 见 §6 设计 |

## 2. 用户要求清单及其演变

1. 0.9 分目标 → **修订**：旧 judge 口径下结构性不可达（oracle 天花板 ≈0.68）；**2026-11-08 起以混合新基准 ≥0.9（保底 0.85）为新目标**——口径改变后目标复活。
2. 记忆收益必须可归因于记忆系统 → **模型无关性矩阵**（5 模型 × dev54 × dshmem/full + 噪声底 + 固定 judge 重判；判据 C1-C5 预注册于 VERIFICATION.md）。
3. 纯文件硬约束（禁向量库/图库/sleep 固化）→ **维持**（2026-11-04 定；2026-11-08 复核维持）；"快速实时召回"若将来需要，走 FlyHash 类纯文件路径（观察项 E）。
4. 个人隐私内容绝不入库 → 已执行（.gitignore + 排除清单 + 敏感串清洗）。
5. 测试内容轮换防过拟合 → **新增（2026-11-08）**，见 §6。
6. 研究路线图每阶段末记录 → **新增（2026-11-08）**，本文件。
7. push 需门禁/用户网络配合；commit 已授权。

## 3. 被推翻的结论/要求（防止复用旧错误结论）

| 旧结论/要求 | 推翻依据 | 现行结论 |
|---|---|---|
| 旧跑分 dsh=0.357 vs full=0.43 有意义 | harness 静默失败 + judge 翻转噪声 | 旧横比全部作废，一切以本工作区重跑为准 |
| 0.9 不可达（终局） | 仅在旧 judge/gold 口径下成立 | 新混合口径下目标复活为 ≥0.9（保底 0.85） |
| cat5 adversarial 低分是记忆系统缺陷 | gold 是被前提调换后的内容词答案（60 题） | 口径修复后 adversarial 0.953 |
| "服务器无限解码卡死"（第一判断） | local_server 有 max_new=2048 硬上限 | 真因三次各异：①eval ingest 超时 900s<抽取时长→已修 14400s ②机器虚拟内存耗尽周期性杀进程（Event 2004）→用户清理缓解 ③Qwen3 混合思考模型 <think> 耗尽预算→已修 enable_thinking=False |
| "记忆系统是纯文本无实时召回段"（用户旧印象） | 代码 grep 证据 | 当前系统零向量成分；带向量实时召回的是前代 ACCF；"实时召回"现由 FTS+LLM 重排+关联图承担 |
| Memobase/star 数等外部情报 | GitHub API 核实 | Memobase 404 退场；star 数不采信；厂商自报分数一律标注不可横比 |
| DSH 命名随意用于仓库名 | 用户指出需 dsh- 前缀（社区合集）+ 特征名 | 定名 dsh-purefile-memory |

## 4. 实验结果总账（全部同尺同协议、逐题快照可复核）

| 实验 | 结果 | 数据位置 |
|---|---|---|
| dev 子集迭代轨迹 | 0.357→0.689→0.859→0.896（54 题最好） | bench/results/locomo_20261029/1031-*.json |
| v3.1 全量（旧协议，deepseek-flash 同尺） | 0.679/0.671/0.687；full-context 基线 0.651~0.719 | locomo_20261028-*.json |
| chaos 能力集（防编造） | 0.767（陷阱题 6/6 满分） | capability_chaos.jsonl |
| detective 能力集 | 0.717 | capability_detective.jsonl |
| **v10 全量回归（本地 Qwen3-4B 同尺，2026-11-08）** | **0.8463**：single 0.807 / temporal 0.717 / multi 0.881 / open 0.877 / **adv 0.953** | locomo_20261108-003528-local-full-v10.json |
| v10 固定-judge 重判 | 0.844（Δ−0.002，judge 稳健） | v10_rejudge_20261108-003912.json |
| 证据供给率 recall@k | **0.329**（供给与得分的差值→改述容忍/模型推理/潜在预训练污染；跨家族矩阵为排除手段） | v10_analyze.py 输出 |
| 启发式 used-rate | 0.423 | 同上 |
| 弃答正确率 | 0.527（110 次自答不知道中 53% 真未提及→检索供给瓶颈） | 同上 |
| 五模型矩阵 | 进行中（q06→q17→phi→smol→q4b + 噪声底 + 收尾重判） | checkpoint_mi-*.jsonl |
| selftest / doctor | 16/16 / 0 错 0 警（多次复验） | mem CLI |

## 5. 过程故障与修复（过程如何推进）

| 故障 | 根因 | 修复 |
|---|---|---|
| eval 三次"停滞/暴毙" | ①ingest 超时 900s < 大对话抽取 50min；②虚拟内存耗尽（Event 2004）周期杀进程；③Qwen3 混合思考 <think> 耗尽预算 | ①timeout=14400（locomo_eval.py:235）②用户清理内存（2.7→9.4GB）③enable_thinking=False + <think> 剥离（local_server.py） |
| push 失败 | 门禁误报（扫描器 scanner_enobufs）+ github.com:443 被墙 | 完整扫描清零误报；Git Data API 逐字节复刻推送；日常走 VPN socks5://127.0.0.1:1081 |
| mi_runner 启动失败 | PS5.1 按 GBK 读无 BOM UTF-8 脚本，中文路径变乱码 | 改 $env:USERPROFILE 纯 ASCII 重写 |
| mem CLI 命令找不到 | 未进 PATH | 注册 agenttools 总线（22 工具） |
| LoCoMo eval 首题后 2h 零进度 | 服务器单生成持全局锁无超时，卡死后全服务堵死 | 生成硬超时 900s（503 + 锁释放） |
| LongMemEval-V2 下载 | VPN SOCKS 对 HF TLS 不稳 | 改 hf-mirror.com 镜像（Qwen3-1.7B/Phi/SmolLM2 三模型同法） |

## 6. 轮换防过拟合设计（新要求，2026-11-08）

**目标**：证明 0.85-0.9 的收益来自记忆系统，而非对同类题目/语料的反复迭代过拟合（含预训练污染——recall@k 0.329 vs 总分 0.846 的差值已提示此风险）。

**三层轮换机制**（按成本递增）：
1. **打乱（零成本）**：每轮评测对题目顺序、抽样种子、对话配对做受控轮换（种子入快照）。
2. **拟造（低成本，首选）**：以 locomo10.json 的对话结构为模板，用本地模型生成**全新人名/事实/时间线的多会话对话**（同型不同文），构建"轮换包"（每轮一包，包与包之间零重叠）；判分口径与 LoCoMo 完全一致，可直接对比。生成一次由 4B 完成（固定生成器模型，防"被测模型自生成自评测"偏倚）。
3. **收集（中成本）**：从互联网/HF 收集同类型（多会话人格化对话 + QA）但不与原语料一致的现成语料作为独立轮换源；LongMemEval-V2 抽样（context-gathering 协议）为其结构化版本。
**范围说明**：LME-V2 的 1.15 亿 token 是其全库 haystack 规模；本机按抽样子集对等比拟造/收集，不承诺全量 115M。
**验收口径**：系统在"从未见过的轮换包"上的分数与 LoCoMo 回归分的差值 ≤0.05 → 收益归因于记忆系统成立；若轮换包分数显著走低 → 存在过拟合/污染，须回溯。

## 7. 外部资料清单（带来源）

**arXiv（编号经 API 核验）**：2609.08258（撤销执行审计，standing 过滤来源）/ 2611.07631 MEMOIR / 2611.02912 StateGraph / 2611.03743 EvoMemState / 2605.12493 LongMemEval-V2 / 2602.16313 MemoryArena / 2604.16548 安全综述 VMG / 2611.01718 MemUse / 2611.05731 Pro-Memory / 2608.28978 图记忆 / 2606.24775 / 2603.11768 / 2604.20300 FSFM / 2611.05636 / 2608.19652 **StateMemBench（状态追踪 13-20%）** / 2611.05791 **FlyHash（非向量快速索引）** / 2609.05553 EdgeMem / 2610.27406 More Memory Worse Agents / 2611.07554 Memory Trap / 2610.17763 Memory Echo / 2610.22668 证据充分性 / 2610.18052 遗忘基准 / 2609.37474 Authority Before Utility / 2610.38521 记忆文件安全 / 2609.23315 图记忆代价。全量 2355 条见普查报告（三路方法与覆盖率声明在各报告头部）。
**GitHub（releases API 核实）**：mem0 68.5k★（38 release）/ letta 25.4k / graphiti 32.6k / cognee 33.1k / basic-memory v1.0 / memU 14.6k / EverOS / hindsight 59.6k / mempalace 60.4k / Hy-Memory 2.0（腾讯）/ agentscope-ai/ReMe（Markdown 即记忆）/ calpaterson/memoryfield-spec / letta-ai/agent-file / tigerless-labs/agent-memory 4310★ / AML-memory/agent-memory-leaderboard 1115★ / MemT-1.0（记忆基座模型）/ Memobase 404 退场。
**基准/工业/社区（WebSearch+WebFetch 核验）**：MemoryArena 站点 / PALM Workshop NeurIPS 2026 / agentmemoryleaderboard.ai（Cycle 2 2026-11 中旬放榜）/ Label Studio LoCoMo 评测文 / llms3.com 6.4% 审计转引 / Verging Labs 2176 任务横评（纯 markdown wiki 98.5，blog 级）/ Anthropic 记忆三连改 release notes / Letta "Is a Filesystem All You Need?" / Mem0↔Zep 方法学互撕。
**不确定项**：BEAM 无 arXiv 编号（mem0.ai 文章转述）；star 数单时点快照；厂商自报分数不可横比；DSH 生态插件星数有互刷嫌疑。

## 8. 阶段记录（每阶段末追加）

### 阶段 S1：合并评测标准建立 + 第一夜（2026-11-08 凌晨）
- LoCoMo 回归 0.8463；重判 0.844；免费指标三件（recall@k 0.329 / used-rate 0.423 / 弃答正确率 0.527）
- 五模型矩阵启动（q06→q17→phi→smol→q4b→噪声底→收尾重判），预计 12-18h
- 三处 harness 修复入库：ingest timeout 14400 / 生成硬超时 900 / enable_thinking=False+<think> 剥离
- 推送：d86b5e8（普查+评估）、4934902（超时修复）、bd45e95（思考补丁）
- LongMemEval-V2 数据集克隆至 D:\AI\bench-data
- 下阶段：矩阵判定 C1-C5 → 轮换包生成器构建 → 合并记分卡 → 状态探针
