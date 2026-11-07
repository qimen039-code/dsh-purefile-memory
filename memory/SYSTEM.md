# DSH 分层记忆系统（v3）

> 一句话：记忆不是聊天备份，而是**会影响下一步行动的状态，以及回到证据的路径**。
> 本文件是存储与行为契约；具体命令见 [`system/README.md`](system/README.md)，AI 操作短协议见 [`system/PROTOCOL.md`](system/PROTOCOL.md)。

---

## 0. 先回答：过去的“历史记忆”在实际对话/任务里是什么

记忆不是“把说过的话存起来”。在实际任务里，它只承担六类作用：

| 类型 | 回答的问题 | 例子 | 失效方式 |
|---|---|---|---|
| 状态 | 现在处于什么阶段？ | 任务进行到“插件待验证” | 阶段推进后更新 |
| 决策 | 为什么选这个、不选那个？ | 放弃 MCP，改本地直连 | 新证据出现后取代 |
| 约束/偏好 | 什么不能做、什么必须做？ | 不自动写入、不删历史会话 | 用户明确更改 |
| 未闭合线索 | 还有什么没解决？ | 插件尚未隔离验证 | 解决/ dissolved / 放弃 |
| 产物/位置 | 东西在哪、怎么用？ | 记录目录、脚本、日志 | 文件移动/版本变更 |
| 证据/边界 | 凭什么相信、何时该推翻？ | 会话 id、命令输出、URL | 反证、过期 |

所以记忆服务于五件事：**续接**（不用重新推导）、**不重复**（不问已知、不做已做）、**不冲突**（旧结论不覆盖新事实）、**可审计**（能回到证据）、**可教**（错误变成下次的检查）。

它不服务于：全量转录、人格画像、情绪诊断、自动替用户做决定、把“像”当成“相关”。

### 记忆的理念

1. **记忆是线索，不是命令。** 当前请求、现场证据、用户明确指令永远优先。
2. **只记会改变下一步行动的东西。** 记不住的细节，不如一个能跳过去的指针。
3. **事实不可改，解释可版本化。** 原始会话/证据不改；结论被取代时保留旧版本与理由。
4. **记忆必须可证伪。** 每条 current 结论都应带 `disconfirmation`（什么条件下应被推翻）。
5. **记忆必须可遗忘。** 封存不是删除，是把注意力成本降下来；争议/否决不是抹除，是退出默认召回。
6. **记忆必须可寻址。** 稳定 id + 固定目录 + 分层文件，AI 才能“顺着摘要往下读”，而不是一次性塞满上下文。

---

## 1. 两态，但不是两个目录

记忆有两条独立轴，不能混成一个 `status`：

| 轴 | 取值 | 含义 |
|---|---|---|
| `temperature` | `hot` / `warm` / `sealed` / `frozen` | 注意力温度：多久没碰、是否进入默认工作集 |
| `standing` | `current` / `superseded` / `contested` / `retracted` / `expired` | 真理状态：现在还算不算数 |

- **hot**：近期活跃的线程/项目/会话；可进入 `brief`。
- **warm**：暂时不活跃但仍可能相关；召回可见，不默认注入。
- **sealed**：一段时间不推进；只保留 L0 卡参与召回，L1-L3 按需下钻。
- **frozen**：长期归档/被否决/被取代；默认不召回，只能按 id 或 `--history` 读取。
- **current**：当前有效结论。
- **superseded**：被新结论取代；保留旧记录与双向链，默认不召回。
- **contested**：有反证或用户否决，尚未裁决；默认不作为事实注入。
- **retracted**：用户撤回；保留证据，不再提。
- **expired**：超过有效期；保留历史。

关键点：**封存只改 `meta.temperature`，不移动文件。** 一个 sealed 记录可以仍是 `current`（休眠但有效）；一个 hot 记录也可以是 `contested`（正在争论）。把“旧”与“错”分开，是防止记忆污染的第一道门。

### 封存判定（默认阈值，可配置）

同时满足才建议封存：

- `last_touched_at` 超过 `sealDays`（默认 30 天）；
- 没有 `unresolved` 的 open loop；
- L1 digest 至少 `sealMinDigestChars`（默认 300 字符）；
- 不是当前任务的直接依赖（由人或 agent 判断）。

不满足时：继续 hot/warm，或先补 digest/关闭线索。`mem seal` 会拒绝不满足条件的记录（`--force` 可保留为“封存但仍有线索”，但会在视图中标注）。

唤醒：`mem wake <id> --hot|--warm`。唤醒不自动改 `standing`；被取代/否决的记录不会被“唤醒”成事实。

---

## 2. 封存四层 + 审计层

每个记录目录从创建起就固定有这些层；封存不新增、不搬迁、不重命名。

| 层 | 文件 | 回答的问题 | 预算/规则 |
|---|---|---|---|
| **L0 元摘要** | `meta.json` | 这是什么？为什么值得打开？现在什么状态？ | gist ≤ 260 字符；只放路由字段 |
| **L1 提炼** | `digest.md` | 任务全貌：目标、时间线、结论、失败、未闭合、边界 | ≤ 6000 字符；封存前 ≥ 300 |
| **L2 索引** | `index.json` | 要跳到哪个文件/会话/URL/日志/决策？ | 每个指针必须可解析 |
| **L3 分类内容** | `content/` | 原始/半原始材料，按类型封存 | transcripts / artifacts / sources / logs / decisions / notes |
| **审计层** | `audit/` + `versions/` | 凭什么信？改过什么？谁在何时用过？ | append-only；事实原文不改 |

### L0 字段（路由卡）

- `id`、`kind`、`title`、`aliases`、`gist`
- `key_points`（3–7 条，≤160 字符）
- `tags`、`entities`
- `workspace`、`project`、`scope`
- `owner`：`user` / `agent` / `tool` / `mixed`（不合并不同 owner 的证据）
- `standing`、`temperature`
- `confidence`、`disconfirmation`
- `open_loops`、`decisions`
- `relations`（`supersedes` / `superseded_by` / `contradicts` / `depends_on` / `derived_from` / `thread_of` / `related_to` …）
- `session_refs`、`artifact_refs`
- `valid_from` / `valid_to`（事实有效时间，区别于 `created_at` 记录时间）
- `review_state` / `review_at`
- `privacy`（sensitive / injectable / redact）
- `paths`、`integrity`

L0 是**唯一默认参与召回的层**。不要把 L1 全文塞进 L0；那会让“摘要路由”退化成“小全文库”。

### L1 必须写清的全貌

1. 背景与目标（为什么会有这条记忆，成功标准）
2. 时间线（发生了什么，按阶段）
3. 结论与决策（含理由、替代方案、被否方案）
4. 当前状态（完成/未完成/阻塞）
5. 失败、放弃或走不通的路径
6. 未闭合问题与下一步
7. 关键实体、文件、产物、外部来源
8. 证据、边界、**这条记忆不覆盖什么**、推翻条件

L1 是“给未来的自己看的一页纸”，不是流水账。细节放 L2/L3。

### L2 指针类型

`index.json.categories` 固定分类：

- `sessions`：`{session_id, workspace, turns, path, summary}`
- `artifacts`：`{path, kind, bytes, sha256, summary, copied_to?}`
- `sources`：`{url, title, accessed_at, quote, snapshot_path?}`
- `logs`：`{path, summary, captured_at}`
- `decisions`：`{id, path, summary}`
- `related_records`：`{id, relation, why}`
- `claims`：`{id, statement}`
- `notes`：`{path, summary, captured_at}`（L3 笔记/设计取舍）

另有 `locators`：`{kind, ref, path, lines?, seq?}`，用于直接跳到文件行号/会话 seq/URL 锚点。索引脚本按这些字段路由，不靠猜。

### L3 存储策略（避免后期搬运）

- 文本/小文件（<256 KB）：可复制进 `content/`，保留 `sha256`。
- 大文件/二进制：存路径 + hash + 摘要；只有在文件可能消失/外部时才复制。
- 会话：保存 `session_id` + turn 范围 + transcript 路径；需要不可变快照时，导出**相关轮次**到 `content/transcripts/`，不复制整个会话库。
- 外部搜索：保存 URL、标题、访问时间、引用片段；可选保存正文快照。
- 日志：只保存与结论相关的片段/命令输出，不保存全量日志。

原则：**canonical 内容不依赖“封存时再整理”**；整理发生在写入时，封存只是降温度。

### 审计层

- `audit/events.jsonl`：created / updated / sealed / woken / superseded / linked / annotated
- `audit/evidence.jsonl`：证据条目（类型、引用、hash、时间）
- `audit/corrections.jsonl`：修正/反证/否决（原文不改）
- `audit/usage.jsonl`：recall/open/brief 使用记录（仅本地）
- `versions/`：L1/L2 被改写前的快照

审计层回答三个问题：**这条结论怎么来的？改过什么？谁在什么时候用过？** 没有审计的记忆，无法判断是“事实”还是“上次的猜测”。

---

## 3. 固定存储契约

```
<repo-root>/memory/
  SYSTEM.md                  ← 本文件（契约）
  README.md                  ← 旧账本说明（v2，保留）
  ledger.json                ← 原子 claim 账本（v2，保留）
  system\                    ← 代码/配置/模板/ schema（不是记忆内容）
    bin\mem.mjs
    lib\{store,sessions,recall,fts,cli,util}.mjs
    config.json
    schemas\record.schema.json
    templates\digest.md
    PROTOCOL.md
  records\<YYYY>\<MM>\<id>\
    meta.json                ← L0
    digest.md                ← L1
    index.json               ← L2
    README.md                ← 人类/AI 入口（生成）
    content\
      transcripts\ artifacts\ sources\ logs\ decisions\ notes\
    audit\
      events.jsonl evidence.jsonl corrections.jsonl usage.jsonl
    versions\
  sessions\<workspace-key>\<session-id>.json / .md   ← 会话卡（派生，可重建）
  index\
    catalog.json             ← 所有 L0 卡（召回主索引）
    sessions.json            ← 会话卡索引
    retrieval.db             ← FTS5/BM25 派生检索索引（可删除/重建，不是 canonical）
    injection.json           ← brief 去重账本
    state.json
  views\
    HOT.md ARCHIVE.md SESSIONS.md MAP.md
    recall\                 ← 显式 recall 快照（审计；非 canonical；可 prune）
  inbox\                     ← 待整理/待审的草稿（不是 canonical）
  cache\                     ← 可重建缓存
```

### 契约规则

1. **记录出生即最终路径。** 路径只由 id 决定；封存/唤醒/取代都不移动目录。
2. **七个固定名字。** `meta.json` / `digest.md` / `index.json` / `README.md` / `content/` / `audit/` / `versions/`。任何记录都有，哪怕为空。
3. **id 不可变。** `rec-YYYYMMDD-HHMMSS-xxxx`；会话 id 用 DSH 原生 `session-<uuid>`。
4. **schema 版本化。** `meta.schema` / `index.schema`；迁移只加字段、不重写旧语义。
5. **原子写 + 单记录锁。** 临时文件 + rename；同一记录的 load→mutate→save 用 `.write.lock` 串行化（30s stale，10s timeout）；索引可重建，不作为唯一真相。
6. **事实原文不改。** 会话、日志、引用片段不改；修正追加 `corrections` / `versions`。
7. **owner 不合并。** 用户说的、agent 推断的、工具观测到的，分别记录；合并会制造“用户说过”的假象。
8. **默认不删除。** 过期/否决/取代用 `standing` 表达；物理删除只由用户明确要求，并留 tombstone。

### 统一 URI（给工具和 AI 用）

```text
mem://<record-id>/l0
mem://<record-id>/l1
mem://<record-id>/l2/<category>
mem://<record-id>/l3/<subdir>/<file>
mem://<record-id>/audit/<file>
dsh-session:<base64url(session-id)>
```

`mem route` 负责把 URI/id 解析成真实路径；AI 不需要自己拼目录。

---

## 4. 写入位置判定：新记录、注释，还是取代？

这是本系统最关键的写入标准。先判断“新内容与旧记忆的关系”，再决定写到哪里。写前可以先用 `mem check "标题 关键词"` 只读查相似记录；不确定是否该成为正式记忆时，先 `mem inbox add` 暂存，确认后再 `mem inbox promote`。两者都不自动改。

| 关系 | 写入动作 | 目录位置 | 旧内容 |
|---|---|---|---|
| 同一事实，新增支持证据 | `audit/evidence.jsonl` 追加 + `touch` | 原记录 | 不改 |
| 细节修正/补充说明，结论仍成立 | `mem annotate --kind correction` | 原记录 `audit/corrections.jsonl`；L1 追加“修正记录” | 原文不改，追加 |
| 结论变化，旧结论若被当作当前会误导 | **新建记录 + `mem supersede`** | 新记录独立目录；旧记录加 `superseded_by` | 保留，标 `superseded`，默认不召回 |
| 同一主题的新分支/子问题 | 新建记录 + `thread_of` / `derived_from` | 新记录；双向 link | 保留 |
| 相关但不同主题 | 新建记录 + `related_to` / `depends_on` | 新记录；双向 link | 保留 |
| 发现反证但尚未裁决 | `mem annotate --kind counter_evidence` | 原记录；`standing=contested`（可显式） | 保留，降 confidence，退出默认注入 |
| 用户明确否决/撤回 | `mem annotate --kind user_veto` | 原记录；`standing=contested/retracted` | 保留证据；不再主动提 |
| 任务完成/休眠 | `mem seal` | 原记录；只改 temperature | L0 仍可召回，L1-L3 按需 |
| 一次性观察，属于当前 episode | 写 `content/notes/<timestamp>-<slug>.md` | 原记录内 | 不新建记录 |
| 归档/隐藏会话，作为历史材料 | `mem inbox add --from-session ... --kind reference --temperature sealed` → promote | 新 sealed reference 记录 | 原会话不动，不作为当前项目结论 |

**归档/隐藏会话默认按“封存参考”处理**：`temperature=sealed`、`kind=reference`；进入 recall 但排在 warm/hot 之后，不进入默认 hot brief，不升级为当前 project claim。只有用户明确要求时才改为 active/project。

### 判定口诀

- **“旧话仍然真，只是不完整” → 注释/补证据。**
- **“旧话现在会误导” → 新记录 + 取代。**
- **“旧话只是历史，不再是当前结论” → 保留 + `superseded`，不是删除。**
- **“两句话都可能是真的，但冲突未裁决” → `contested`，两边都保留，不注入为事实。**
- **“只是同一任务里的一个细节” → 写进原记录的 notes/L2，不要每个发现都开新记录。**

### 为什么不在旧结论处直接改正文？

因为改正文会抹掉“当时为什么这么判断”。以后无法区分：

- 是当时证据不足？
- 是用户后来改主意？
- 是环境变了？
- 是 agent 当初判断错了？

保留旧版本 + 新记录，才能让“取代”可审计；注释用于“旧结论仍成立，但需要限定/补充”。

### 目录内到底放哪？

- **新结论/新主题**：新记录目录，不塞进旧记录。
- **同一结论的补充证据**：旧记录 `audit/evidence.jsonl`。
- **同一结论的修正**：旧记录 `audit/corrections.jsonl` + L1 末尾“修正记录”。
- **同一任务的中间观察**：旧记录 `content/notes/`。
- **决策的理由/替代方案**：`content/decisions/` 或 L0 `decisions`（重要决策）。
- **外部资料**：`content/sources/` + L2 `sources`。
- **产物**：`content/artifacts/` 或 L2 指针（大文件）。

---

## 5. 何时写入、何时更新

写入是**事件驱动**的，不是每轮对话都写。默认只在以下时点写：

| 触发 | 写什么 | 去哪 |
|---|---|---|
| 用户给出持久偏好/约束/身份事实 | claim candidate（v2 账本） | `ledger.json`（用户确认后 active） |
| 任务开始（多步/长期） | 新 episode/project 记录 | `records/` |
| 任务结束/暂停 | L1 更新 + 未闭合 + 产物 + 封存判断 | 原记录 |
| 用户纠正/否决 | correction / user_veto | 原记录 audit |
| 结论被新证据推翻 | 新记录 + supersede | 新记录 + 旧记录链 |
| 产出文件/报告/代码 | L2 artifact 指针 | 原记录 |
| 外部搜索得到关键来源 | L2 source | 原记录 |
| 同一事实被反复重新推导 | 提升为 claim / L0 key point | 账本/记录 |
| 会话结束/切换项目 | 会话卡刷新（自动） | `sessions/` |
| 压缩/交接前 | 更新 reasoning state + L1 | `state/reasoning.md` + 记录 |
| 发现旧记录该封存 | seal（需满足条件） | 原记录 |

**不写**：闲聊、临时工具输出、推理链原文、秘密/凭据、可从代码/文档直接读到的内容、没有证据的猜测、人格定性。

### 两段式

- **claim**：`candidate` → 用户确认 + 证据 + disconfirmation + scope → `active`。
- **record**：`draft` → 补齐 L1/L2 → `reviewed` → 可封存。
- 任何自动索引/会话卡都是**派生数据**，不是 canonical 结论；不能自动升级成 active claim。

### 预算

- L0 gist ≤260 字符；L1 ≤6000 字符；brief ≤1200 字符。
- active claims ≤20（全局+工作区各 20 的旧规则仍适用）。
- hot 记录默认 ≤40；超出时先封存最久未触碰且无线索的。
- 一次 `brief` 默认最多 6–8 条；超出截断并提示。

---

## 6. 召回与路由

### 分层召回（从便宜到贵）

1. **显式 id/URI**：直接 `mem route`，不搜索。
2. **L0 目录召回**：标题/别名/tags/entities/gist/key_points/open_loops + 结构化过滤（workspace/kind/standing/temperature）。默认只到这里。
3. **图扩展**：沿 `relations` 一跳（supersedes / thread_of / derived_from / related_to）；用于“这条记忆的前因后果”。
4. **会话卡**：标题/逐轮 outline；跨项目找“哪次聊过”。
5. **L1 深搜**：`--deep`，只对短名单读 digest；用于 L0 太短、query 是概念性的情况。
6. **v2 claim 账本**：原子偏好/协议；只在匹配时并入。
7. **可选语义 rerank**：未来扩展点；默认不用，避免每次召回依赖模型/网络。

### 评分（当前实现）

- 字段权重：title/alias 9/8，tags/entities 4，gist 3，key_points/open_loops/decisions 2。
- 多词查询有 **coverage 惩罚**：只命中一半词，分数乘 ~0.8；避免“沾一个词就高分”。
- `standing != current` 扣分并默认过滤；`sealed` 扣 1.5；`frozen` 扣 3。
- 同工作区 +1.2；hot +1；confidence/recency 小幅加权。
- 每个 project 最多 2 条，避免一个项目刷屏。
- 没有词面命中时不再用 confidence 把结果“抬进来”。

### 路由

```text
mem recall "query" --k 5
mem route <id> --layer l1 --open
mem route <id> --layer l2 --category artifacts --open
mem route <id> --layer l2 --category notes --paths    # 只输出可读文件路径，接官方 read/grep
mem route <id> --layer l3 --category transcripts
mem route <id> --layer audit --file corrections.jsonl
mem route <id> --layer readme
```

`mem route` 是“定位跳转连接器”：它按 L0 的 id/查询找到记录，再按层/分类返回**真实路径**或内容。AI 可以先拿 L0，再只打开需要的那一层，不必把整个封存包读进上下文。

### 效率实测（本机）

- 20 个会话索引：约 0.2 s（首次含 hash；后续缓存）。
- L0 召回（2 条记录 + 20 会话 + 2 claim）：约 1–2 ms。
- 读取 12 轮会话全文：约几十 ms（zstd 解压 + 解析）。
- 真实瓶颈不是索引，而是**把不该读的内容读进上下文**；所以默认只返回 L0。

---

## 7. 上下文注入：必要，还是非必要？

### 默认：pull，不 push

**不自动把记忆全文注入系统提示/每轮上下文。** 理由：

1. **重复**：当前对话已经包含刚说过的事；再注入一遍是 token 浪费。
2. **冲突**：旧结论一旦进入系统提示，会被模型当成“当前命令”，压过新证据。
3. **污染**：封存包的细节会挤占当前任务注意力。
4. **缓存**：每轮变化的前缀会破坏 KV cache 复用。
5. **权威错位**：记忆应是“线索”，不是“政策”。

### 什么时候需要注入？

只有满足以下之一，才值得把记忆放进上下文：

- 用户在**续接**旧任务（“继续/上次/之前/那个”）；
- 用户明确问“你还记得吗”；
- 当前决策**可能已经有过结论**（选型、约定、路径）；
- 进入**新工作区/新项目**，需要最小背景；
- 发现新旧信息**可能冲突**，需要旧结论做对照；
- 压缩/交接前，需要把工作集固化。

即使触发，也只注入 **delta**，不注入全量。

### `brief` 的去重机制

- 每条候选生成 `hash = sha1(id + updated_at + gist)`。
- `index/injection.json` 按 session 记录已注入的 hash。
- 同一 session 再调用 `brief`：只返回新 hash；未变的条目计入 `omitted`。
- `--full` 绕过去重；`--reset` 清空该 session 记录。
- `superseded/contested/retracted` 永不进入 brief；`sensitive` / `injectable=false` 永不进入。
- 只注入 `hot/warm` 且当前有效；封存内容必须显式 `mem route` 打开。

### 三种“注入”要分开

| 通道 | 内容 | 是否自动 | 风险 |
|---|---|---|---|
| 规则/技能（静态协议） | “何时 recall、怎么下钻、写入边界” | 随 AGENTS/skill 加载 | 低；不是记忆内容 |
| `brief`（动态热记忆） | 当前工作集 delta | 需要显式调用 | 中；靠去重/预算控制 |
| 原生 `@` 会话快照 | 被引用会话的文本快照 | 用户 @ 时由 DSH 注入 | 中；有界、不受信任警告 |
| 封存 L1-L3 | 完整历史 | 只有 `route --open` | 高；绝不默认注入 |

结论：**注入不是必要，除非它会改变下一步行动或防止已知错误。** 默认让 AI 自己“按需拉”，比每轮“推”更稳。

---

## 8. 任意会话 @ 读取（跨项目）

DSH 已原生支持跨会话引用：

```text
@[标题](dsh-session:<base64url(session-id)>)
```

或裸 `dsh-session:` URI。用户在输入框 @ 一个会话时，DSH 会把该会话的**有界文本快照**作为第二条 user 消息注入，带“不受信任背景”警告；快照只含用户/assistant 文本与压缩检查点，不含工具/推理，且捕获后不可变。一条消息最多引用 3 个不同会话（DSH 默认 `maxReferences=3`）。

本系统补两层：

1. **会话卡**：`sessions/<workspace>/<session-id>.json|.md`，标题、gist、逐轮 outline、transcript 路径、sha256、原生 mention。
2. **全文读取**：`mem session show <id>` / `context <id>` / `find <query>`，跨所有工作区扫描 `~/.dsh/sessions`，按 v4 JSONL 解析用户/assistant/工具/产物事件。

用法：

```text
mem session find "ACCF 隔离"
mem session show 441ffb80 --last 3
mem session context 441ffb80 --last 3
mem session link 441ffb80          # 打印原生 @ mention
```

- **接续内容** → `context`（最近轮次 + 未闭合 + 关联记录 + 产物）。
- **前因后果** → `show`（完整轮次）+ `route`（关联记忆的 L1）。
- **跨项目** → 会话索引按 header `cwd` 归属，不按当前工作区限制；`--all-workspaces` 用于召回。
- **持久化**：desktop profile 的 `cordis.patch.yml` 显式启用 `session-reference`，并把 `memory` 目录从 `file-reference-local` 的 @ 文件候选中排除；否则 `memory/sessions/*.md` 会话卡会与原生会话引用在 @ 菜单里重复。
- **边界**：原生快照有预算、只文本；`mem session show` 读本机文件、能看到工具调用但默认截断；会话被压缩后，旧事件可能被 shadow，需以 `compaction/prune` 为界理解。

---

## 9. 取代、修正、否决（来自 Twig / ACCF 的硬规则）

- **事实层不可改**：原始会话、日志、引用片段不改；修正只追加。
- **结论层可改写，但留版本**：L1 改写前存 `versions/`；L0 结论变化用新记录 + supersede。
- **反证必须显式裁决**：不能“看到了但悄悄吞掉”；`counter_evidence` 记录，`contested` 退出默认注入。
- **conviction 衰减**：每次反证/否决降低 confidence；反复被挑战的结论更快进入复核。
- **用户否决 = contested，不是删除**：保留“曾被提出、被否决”的事实；不再用同一批旧证据重复生成同一结论。
- **再提门槛**（Twig 思路，默认不自动执行）：至少 3 条独立新证据、冷却 14 天、邀请式措辞；同一结论被否决 2 次则永久退出再提通道。
- **取代链**：新记录 `supersedes` 旧记录；旧记录 `superseded_by` 新记录；用 `mem chain <id>` 顺链读。`relations` 保留完整理由。

---

## 10. 与 v2 账本、ACCF、Twig 的关系

### v2 账本（保留）

- `ledger.json` 管**原子当前真理**：偏好、约定、协议、claim、thread、handoff。
- v3 `records/` 管**叙事上下文**：发生了什么、为什么、产物在哪、如何续接。
- 两者用 `evidence_ids` / `relations` / `session_refs` 互相指。
- 不要把一个长任务的全部细节塞进 claim；也不要用 record 替代“用户偏好”这种需要严格确认的原子条目。

### 从 ACCF 吸收

- **2026-10-26 起 ACCF 只保留遗留只读**：live store 已清空，写入工具已移除；不要再把 ACCF 当记忆存储。下面的思想已吸收进 v3。
- owner 三分：`user` / `agent` / `tool`；不合并。
- 动作语义：`add` / `update` / `supersede` / `absorb` / `skip`；我们映射为 new/annotate/supersede/link/ignore。
- `episode` 与 `session` 解耦：一次讨论/任务可以跨多个 session；一个 session 也可以含多个 episode。
- `disconfirmation` 必填；没有它不能 current。
- `belief_chain`：取代保留旧状态，不合并正文。

### 从 Twig 吸收

- 三层叙事：事实碎片（不可改）/ 线索（未闭合问题）/ 认识（改写式活文档）。
- 线索六态与 `closure_reason`：resolved / dissolved / abandoned / superseded / merged。
- 反证搜索、强制裁决、conviction 衰减、盲推导审计（本系统先留字段/流程，不自动跑 LLM）。
- 用户最终解释权；否决后 contested；再提门槛。
- 情感层只作为语气/重要性信号，不作为事实/权限依据。

### 刻意不做

- 人格画像自动注入、情绪诊断、SILENT/回避信号推断。
- 每轮自动 L0-L3 蒸馏、无审批自动写入、自动合并正文。
- 把“像”当“相关”的纯向量 top-k；默认先用结构化 L0 + 词面/图。
- 用记忆直接推出“少做/拒绝/降级”。

---

## 11. 适配不断变化的 harness

1. **canonical 是普通文件**：JSON/Markdown，不依赖某个数据库或插件生命周期。
2. **适配器隔离**：DSH 会话格式/投影缓存/zstd 只在 `system/lib/sessions.mjs` 处理；格式变了只改适配器。
3. **索引可重建**：`catalog.json` / `sessions.json` / `retrieval.db` / views 都是派生；删了可 `mem reindex` 或 `mem index-build`。`retrieval.db` 过期时 recall 自动回退 `catalog.json` 基线，不阻塞读取。
4. **稳定 URI**：`mem://<id>/<layer>` 和 `dsh-session:`；路径变了只改 resolver。
5. **schema 版本化**：新增字段不破坏旧记录；`doctor` 检查兼容性。
6. **插件薄**：DSH 插件只做工具包装；核心逻辑在 CLI/lib，其他 harness 也能接。desktop profile 当前由 `dsh-memory-ledger` 桥接 `dsh-memory-vault` 的 6 个 `mem_*` 工具（加上账本 2 个共 8 个）；重启后生效，不要重复安装 `dsh-memory-vault`。
7. **能力探测**：`mem doctor` 检查 zstd、sessionsRoot、projectionRoot、DSH 版本；缺能力时降级（没有 projection 就读 header/transcript）。
8. **不绑定提示词**：记忆协议放规则/skill；插件只提供工具，不自动注入正文。

---

## 12. 运维

```text
# 每天/每次续接
mem brief --session auto
mem recall "主题" --k 5

# 新任务
mem new --title ... --gist ... --kind episode

# 任务结束
mem digest <id> --file summary.md
mem seal <id>

# 新结论推翻旧结论
mem supersede <old> --title ... --gist ... --digest-file new.md
mem chain <old>

# 修正/反证/否决
mem annotate <id> --kind correction --text ...
mem annotate <id> --veto --text ...

# 维护
mem reindex --sessions
mem doctor
mem selftest
mem sweep
```

- `doctor`：schema、id/目录、digest 预算、relations、supersede 双向链、会话索引、claim 预算、zstd。
- `selftest`：临时目录跑创建→召回→路由→封存→取代→修正→去重→唤醒。
- `sweep`：列出可封存/待复核/未 reviewed；不自动封存。
- 备份：`records/` 是普通目录，可随部署根的备份目录一起备份；不要只备份索引。
- 隐私：`privacy.sensitive` 记录不进入 brief/recall（除非 `--allow-sensitive`）；凭据不写入。

---

## 13. 已知限制（诚实版）

- 召回质量主要由 **L0 卡写得好不好** 决定；写一堆空泛 gist，任何检索算法都救不了。
- 默认词面/元数据召回，不做 embedding；同义改写/跨语言查询可能漏。扩展点已留，但不默认引入模型依赖。
- 会话解析依赖 DSH v4 格式与 projection cache；格式变化需更新适配器；压缩后的旧事件可能不可见。
- 原生 `@` 快照有预算且只文本；长会话会被截断，需 `mem session show` 补全文。
- 自动摘要/自动封存尚未做（也不建议在无审批时做）；当前靠 agent/用户显式写 L1。
- `brief` 去重按 session；跨 session 的重复注入尚未做全局去重（会误伤不同任务，暂不做）。
- 封存“建议”是时间阈值，不等于“永远不再需要”；sealed 仍可被强匹配召回，frozen 才默认排除。
- 没有自动冲突检测；`supersede/contested` 需要写入者判断并留痕。

---

## 15. v3.1 变更（2026-10-28，LoCoMo 审计驱动）

审计背景：`bench/locomo_eval.py` 同协议对比显示，旧 `dsh-memory-ledger` 词面复刻在 10 对话
294 题上均值 0.357（full-context 基线在同一不可靠 harness 下 0.43；修复 harness 后基线 ≈0.70）。
逐题审计确认四个根因：问题虚词污染词面匹配；说话人名没有锚定到话语；无时间锚定；
原始轮次直接 top-k 噪声大。针对这四点，v3.1 在不动 canonical 契约的前提下新增：

1. **事实层（`system/lib/facts.mjs`）**：记录内 `content/facts/facts.jsonl`，每条事实
   `{id, record_id, session_key, statement, speakers, entities, date_iso, said_iso, kind, confidence}`。
   自包含原子陈述：主语用真名、保留专有名词与时间框架、事件日期与说话时点分开。
   canonical 归 L3 邻接层（半原始材料），索引与打分是派生逻辑。
2. **摄入（`system/lib/dialog.mjs`，`mem ingest-dialog`）**：多会话对话 → 一条 episode 记录
   （L0 卡 + L1 时间线 + L3 transcripts + facts）。幂等：`meta.integrity.facts_hash`。
   事实抽取走 `semantic`（LLM），无配置时词面兜底（每轮一条弱事实）。
3. **事实召回（`recallFacts`）**：查询分析（停用词表、实体识别、时间/对比类判定）→
   词面候选（who 权重 > statement > turn 引文）→ 可选语义重排（一次 LLM 调用，0-3 分，
   LLM 分主导、词面归一补位）。候选为空才弃答；其余情况始终给 top-k。
4. **语义层（`system/lib/semantic.mjs`，config-gated）**：`config.semantic.{enabled,baseUrl,
   apiKeyEnv,model}`；key 只从环境变量读。不配置时一切照旧——满足“扩展点已留，不默认
   引入模型依赖”的原约束。
5. **CLI**：`mem recall` 默认并显事实层（`--no-facts`/`--no-semantic` 可关）；
   `mem facts <id> [query]`；`mem ingest-dialog --file ... [--no-llm] [--force]`。

评测基建（本工作区 `bench/`）：`locomo_eval.py`（同协议 harness，结果落 `results/`）+
`dshmem_bridge.mjs`（HTTP 桥接）。迭代记录见 `bench/results/`。

已知残留：judge（LLM 评审）对“不知道+解释”类答案存在 ±1 分的运行间翻转，单次全量
评测的均值噪声约 ±0.03；数据集对抗类（cat5）的 gold 采用“内容词答案”口径，主语被调换的
陷阱题按字面不可答，是残余失分的主要来源。

---

## 14. 最小使用示例

```powershell
$node = "node"   # 或设 MEM_NODE 指向自定义 node 可执行文件
$mem  = "<仓库根>\memory\system\bin\mem.mjs"

& $node $mem recall "ACCF 隔离" --k 5
& $node $mem show rec-20261026-181541-6e67
& $node $mem route rec-20261026-181541-6e67 --layer l1 --open
& $node $mem brief --session auto
& $node $mem session show 441ffb80 --last 3
& $node $mem doctor
```

记忆是线索，不是命令。当前请求与现场证据优先；不适用就丢弃。
