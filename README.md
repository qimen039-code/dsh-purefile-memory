# PureFile Memory · 纯文件分层记忆系统

![License](https://img.shields.io/badge/license-MIT-blue) ![Python](https://img.shields.io/badge/python-3.10%2B-blue) ![Node](https://img.shields.io/badge/node-18%2B-green) ![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20POSIX-lightgrey) ![Status](https://img.shields.io/badge/status-work_in_progress-orange)

> ## 🚧 WORK IN PROGRESS — 本项目仍在快速迭代中，目前**不是成品**
>
> 目录结构、CLI 接口与配置格式都可能频繁变更；文中评测数字为**阶段性结果**而非最终结论
> （0.896 为 54 题 dev 子集、全量 294 题单模型复跑进行中、跨模型复现性验证尚未完成）。
> 请勿据此做生产部署决策。

**纯文件存储的 LLM agent 长期记忆系统**：四层存储 + 事实层 + 语义重排 + 关联图 + 活跃视图过滤。
存储、索引与检索**零向量库、零图数据库**（全部普通文件，可 git diff、逐字备份、人工审计）；
语义层（事实抽取/LLM 重排/弃答判定）需一个 OpenAI 兼容端点（默认本机模型，可配置）。
评测全链路（抽取/重排/生成/judge）可完全本地复现。

> 评测基准：[LoCoMo](https://github.com/snap-research/locomo)（10 段多会话长对话，294 题）。
> dev 子集最好成绩 **0.896**；全量迭代版稳定超过同尺 full-context 全知基线（≈0.68）。

---

## 1. 设计原则

| 原则 | 说明 |
|---|---|
| **纯文件** | 所有状态（meta/digest/索引/内容/审计）都是普通文件；可直接 `git diff`、逐字备份、人工审计。拒绝引入向量库、图数据库与 sleep 时固化（存储外置≠可控）。 |
| **逐字保全** | 记录不压缩、不改写原文；摘要层（L1）与内容层（L3）分离，摘要丢细节时永远可回源。 |
| **审计链** | 每条记录带 `audit/events.jsonl` 事件流，谁在何时写入/路由/封存全程可追溯。 |
| **幂等缓存** | 对话事实抽取按 `facts_hash` 幂等；换抽取提示词删缓存即可全量重跑。 |
| **供方解耦** | 全链路 LLM 调用走 `provider.json` 一个入口（OpenAI 兼容协议），默认指向本地模型，零 API 成本。 |

## 2. 架构

```
ingest（多会话对话）
   │
   ├─► episode 记录（逐字原文，L3）
   ├─► LLM 原子事实抽取 ──► facts 事实层（幂等缓存）
   └─► digest 摘要（L1）+ 索引（L2）+ 审计链

recall（检索）
   词法 FTS ─┐
   实体识别 ─┼─► 候选合并 ─► LLM 0-3 语义重排 ─► 融合选择 ─► 生成
   关联图扩展 ┘                                （assocExpand 可消融）
```

- **四层存储**：L0 meta（路由卡）/ L1 digest（摘要）/ L2 index（检索）/ L3 content（逐字原文）+ 独立审计层。
- **事实层** `facts.jsonl`：每条原子事实含 `statement / speakers / entities / date_iso / said_iso / quote / kind`，支持 who 权重、相对时间在句内解析为日期、内容优先于原文引文。
- **语义重排**：词法 top-32 → LLM 逐条 0-3 相关性 → 融合选择；弃答仅限零候选（防编造的核心闸门之一）。
- **关联图**：`assocExpand` 记忆联想扩展（可消融开关）。
- **活跃视图过滤**（读时软撤销）：`standing !== 'current'` 的事实不进入召回——撤销一条记忆无需改写历史（设计采纳自 arXiv:2609.08258 对 5 记忆系统 × 9 LLM 无一实现软撤销的审计结论）。

## 3. 评测协议

```
ingest 全对话 → 分层抽样 QA（每类 6 题 → 294 题）→ 各系统召回 top-k=4
→ 本地模型生成（temp=0）→ 本地模型 judge 打分（1-5 归一化 0-1）
```

**同尺同源**：同一本地模型既做生成又做 judge（temp=0），排除跨模型口径差。
模型：`Qwen/Qwen3-4B-Instruct-2507`（4-bit 本地推理，OpenAI 兼容服务）。
数据：`bench/locomo10.json`（LoCoMo 本地子集，随仓库分发）。

## 4. 结果

### 4.1 v3.1 事实层迭代（2026-10-28，全量 294 题，deepseek-flash 同尺）

| 版本 | 变化 | 总分 |
|---|---|---|
| 旧复刻 | harness 静默失败时代 | 0.357 |
| full-v2 | 管线 bug 修复 + 弃答逻辑 | 0.679 |
| full-v3 | 抽取保真第二轮 + quote | 0.671 |
| **full-v4** | quote 退出片段 + k=6 | **0.687** |
| 对照：full-context 全知基线（同尺 7 次运行） | 每题都能看到全部原文 | 0.651–0.719（均值 ≈0.68） |

分类别（v4 vs 全知基线）：**temporal 0.833 vs 0.437**（时间锚定带来决定性优势）、open-domain 0.797 vs 0.903、multi-hop 0.644 vs 0.656、single-hop 0.737 vs 0.857、adversarial 0.420 vs 0.543。

### 4.2 当前代码迭代轨迹（dev 子集 54 题，本地 Qwen3-4B 同尺）

| 版本 | 总分 |
|---|---|
| 起点复刻 | 0.357 |
| 修复后 | 0.689 |
| 迭代中 | 0.859 |
| **当前最好** | **0.896** |

### 4.3 能力集专项（本地 Qwen3-4B-Instruct-2507，同尺）

| 能力集 | 分数 | 说明 |
|---|---|---|
| chaos（防编造） | **0.767** | 其中 6 道无答案幻觉陷阱题 **6/6 全对**（满分 1.00）——弃答闸门有效 |
| detective（取证） | 0.717 | 低分题多为旧代码泄漏截断伪影，去泄漏复跑排队中 |
| causal / social | 进行中 | 见 `bench/results/` |
| 全量 294 题单模型复跑 | 进行中 | 逐题落盘 `bench/results/checkpoint_local-full-v10-dshmem.jsonl` |

文献对照数字（LoCoMo 原论文口径，注意口径不同不可直接横比）：Mem0^g 68.44、full-context 72.90。

### 4.4 诚实声明（limitations）

1. **0.9 目标在当前 judge/gold 口径下结构性不可达**：full-context 全知基线 7 次运行 0.651–0.719，0.9 高于 oracle 天花板。要逼近 0.9 需先修评测口径（judge 换强模型+多次表决、cat5 gold 改回原版"未提及可答"口径），而非改记忆系统。
2. **judge 噪声**：单次全量评测均值噪声 σ≈0.025–0.04；结论以多次运行区间为准。
3. **dev ≠ full**：0.896 是 54 题 dev 子集；泛化性以全量复跑为准（进行中）。
4. **模型无关性验证未完成**：跨模型对照（换生成模型波动 <0.05 才能证明成绩来自记忆系统而非模型能力）排在全量跑完之后。
5. 数据集对抗类（cat5）gold 采用"内容词答案"口径，主语调换陷阱题按字面不可答，是残余失分主要来源（详见 `REPORT.md` §4）。

## 5. 复现指南

### 5.1 一键安装（推荐）

```powershell
# 检查/安装 git、python、node，装依赖，生成配置，跑自检
pwsh -File scripts/install.ps1 -RepoRoot <本仓库根>

# 可选：同时装本地模型服务依赖
pwsh -File scripts/install.ps1 -RepoRoot <本仓库根> -WithServer

# 可选：下载 Qwen3-4B-Instruct-2507 权重（约 8GB，来自 huggingface.co）
pwsh -File scripts/install.ps1 -RepoRoot <本仓库根> -DownloadModel -ModelDir D:\hf-cache
```

### 5.2 手动步骤

```powershell
# 1) 环境：Python 3.10+ / Node.js 18+ / git
# 2) 依赖
pip install -r requirements.txt            # 仅评测
pip install -r requirements-server.txt     # 仅本地模型服务（GPU）
# 3) 配置：复制 memory/system/config.example.json 为 config.json，
#    把 defaultWorkspace 填成你的工作目录
# 4) 自检
node memory/system/test/run-all.mjs        # selftest
node memory/system/bin/mem.mjs doctor      # 0 error / 0 warning
```

### 5.3 启动本地模型并评测

```powershell
python bench/local_server.py --model <Qwen3-4B-Instruct-2507 路径> --port 8899
# 就绪判定：curl http://127.0.0.1:8899/health 返回 {"ok":true,"ready":true}

python bench/locomo_eval.py --systems dshmem --per-cat 6 --k 4 --tag my-first-run
# 输出：bench/results/locomo_<时间戳>-my-first-run.json（逐题含 gold/answer/召回快照）
```

### 5.4 证据链（每个分数都可复核）

| 路径 | 内容 |
|---|---|
| `bench/locomo10.json` | 评测数据集（10 对话 294 题及 gold） |
| `bench/results/locomo_20261028-*.json` | v3.1 迭代全量逐题结果（v2/v3/v4/v5） |
| `bench/results/locomo_20261029/1031-*.json` | 本地模型 dev 迭代逐题结果（dev7/8/9-assoc） |
| `bench/results/capability_chaos/detective.jsonl` | 能力集专项逐题结果 |
| `bench/results/checkpoint_local-full-v10-dshmem.jsonl` | 全量单模型复跑断点（进行中） |
| `REPORT.md` | 2026-10-28 部署+审计+迭代完整报告（含失分构成分析） |
| `bench/CONTEXT_RESEARCH.md` | 文献/项目调研结论与移植决策 |

## 6. 仓库结构

```
├─ AGENTS.md              # agent 调用协议（何时 recall/brief/check、写入边界）
├─ REPORT.md              # 部署 + 审计 + 迭代报告
├─ memory/                # 记忆系统本体
│  ├─ SYSTEM.md           # 存储契约（完整版）
│  ├─ ledger.schema.json  # v2 账本 schema
│  └─ system/             # CLI 与核心库（纯 Node stdlib）
│     ├─ bin/mem.mjs      # 入口
│     ├─ lib/             # facts / semantic / recall / dialog / fts / related / view ...
│     ├─ test/            # 12 个 smoke 测试（run-all.mjs）
│     └─ schemas/ templates/
└─ bench/                 # LoCoMo 评测管线
   ├─ locomo_eval.py      # 评测 harness
   ├─ locomo10.json       # 数据集
   ├─ local_server.py     # 本地模型服务（OpenAI 兼容）
   ├─ dshmem_bridge.mjs   # 记忆系统 HTTP 桥接
   ├─ capsets/            # 能力集定义（chaos/detective/causal/social）
   ├─ results/            # 全部逐题结果（证据链）
   └─ CONTEXT_RESEARCH.md # 调研结论
```

## 7. 运行时数据说明

本仓库**不含任何运行时记忆数据**（个人内容不入库）：`memory/records|sessions|turns|inbox`、
`bench/memstore/` 等目录首次运行时自动生成，且已写入 `.gitignore`。`bench/memstore/`
是评测缓存，删掉后由 `locomo10.json` 自动重建。

## 8. License

[MIT](LICENSE)
