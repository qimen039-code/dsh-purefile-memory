# DSH 记忆账本（Memory Ledger）

> **v3 分层记忆系统已建立**：活期/封存两态、四层封存（L0 meta / L1 digest / L2 index / L3 content）+ 审计层，入口见 [`SYSTEM.md`](SYSTEM.md)，CLI 见 [`system/README.md`](system/README.md)。本 README 继续描述 v2 原子 claim 账本；两者并用，不互相替代。

本目录是记忆契约的结构化数据层。契约本身分两层：全局与项目两级 `AGENTS.md`（由各自 `rules/` 目录生成，宿主自动加载）。这里管“记什么、字段怎么填、怎么校验”。

- 账本文件：`ledger.json`（本目录）
- 校验器：`validate-memory.mjs`（本目录）
- 插件：部署目录中的 `plugins/dsh-memory-ledger`（只读召回工具 `memory_recall` / `memory_status`）

没有自动捕获、没有自动注入、没有自动合并。账本默认只通过 `memory_recall` 工具按需读取；活跃记忆的提示快照由插件按预算生成。

---

## 1. 两段式写入

```
candidate（候选，不参与召回）
   │  证据 + disconfirmation + scope + 适用范围 + 用户确认
   ▼
active（活跃，可被召回）
   │  用户否决 / 过期 / 被新证据推翻 / 被取代
   ▼
contested / expired / superseded / archived
```

- 任何新记忆先写 `candidate`。
- `active` 必须同时具备：`evidence` 至少一条、`disconfirmation` 非空、`scope` 明确、`applies_when` 非空、`confidence >= 0.6`、用户确认。
- 没有 `disconfirmation` 的记忆不可证伪，不能进入 active。

---

## 2. 字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | `mem-YYYYMMDD-xxxx`，全局唯一 |
| `kind` | 是 | `preference` / `fact` / `convention` / `protocol` / `claim` / `thread` / `handoff` |
| `status` | 是 | `candidate` / `active` / `contested` / `superseded` / `expired` / `archived` |
| `scope` | 是 | `global` 或 `workspace` |
| `workspace` | workspace 时必填 | 例如仓库根路径；global 可为空 |
| `owner` | 是 | `user` 或 `agent`，跨 owner 不合并 |
| `title` | 是 | 短标题 |
| `statement` | 是 | 一句话结论/观察/规则；不写人格定性 |
| `applies_when` | active 必填 | 适用条件数组 |
| `does_not_apply_when` | 是 | 不适用条件数组；可为空数组，但必须显式写 |
| `evidence` | active 必填 | `[{type, ref, note}]`；type：`session` / `file` / `command` / `url` / `user` |
| `disconfirmation` | active 必填 | 什么条件下这条应被推翻/改写 |
| `confidence` | 是 | 0–1；active 阈值 0.6；被反证挑战后建议每次 -0.1 |
| `created_at` | 是 | ISO 8601，带时区 |
| `last_verified_at` | 是 | 上次用现场证据核对的时间 |
| `expires_at` | 是（可为 null） | `fact` / `claim` / `protocol` 建议 90 天内；过期降级 |
| `supersedes` | 是（可为空数组） | 被本条取代的旧条目 id 列表 |
| `superseded_by` | 是（可为 null） | 取代本条的新条目 id |
| `closure_reason` | thread 必填 | 线索关闭原因；`dissolved` 必须写“为什么不再成立” |
| `policy_effect` | 是 | `none` / `check` / `ask` / `handoff`；禁止“避开/降级/拒绝” |
| `priority` | 否 | 0–100，只影响召回排序，不影响是否写入/是否有权威 |
| `tags` | 是（可为空数组） | 检索标签 |
| `endogenous` | 否 | true = 证据由助手自身干预催生，不能当干净证据；默认 false |

### 2.1 kind 专属字段

**thread（未闭合线索）**

| 字段 | 说明 |
|---|---|
| `open_question` | 悬置的问题，不是事件本身 |
| `thread_status` | `unresolved` / `resolved` / `dissolved` / `abandoned` / `superseded` / `merged` |
| `lineage` | `{parent_ids: [], child_ids: []}` |
| `closure_reason` | 关闭原因；`dissolved` 必须解释“前提为什么不再成立” |

**handoff（跨会话交接）**

| 字段 | 说明 |
|---|---|
| `task_id` | 任务 id |
| `goal` | 目标 |
| `stage` | 当前阶段 |
| `next_action` | 下一步动作 |
| `unknowns` | 未知项数组 |
| `evidence` | 交接依据 |

**protocol（可复用做法）**

| 字段 | 说明 |
|---|---|
| `context_tags` | 触发上下文标签 |
| `evidence_ids` | 支撑条目/证据 id；active 时不得为空 |
| `statement` | 规则本身必须自带上下文，不写“总是/永远” |

---

## 3. 示例

### 3.1 preference

```json
{
  "id": "mem-20261025-a1b2",
  "kind": "preference",
  "status": "active",
  "scope": "global",
  "workspace": "",
  "owner": "user",
  "title": "先结论后细节",
  "statement": "用户偏好先给结论和判断，再展开依据；不要用大段铺垫开头。",
  "applies_when": ["技术解释", "方案对比", "任务汇报"],
  "does_not_apply_when": ["用户明确要求逐步推导", "教学场景需要完整推理链"],
  "evidence": [{"type": "user", "ref": "2026-10-25 对话", "note": "用户明确要求"}],
  "disconfirmation": "用户表示更喜欢先看细节或完整推导时，此条失效。",
  "confidence": 0.9,
  "created_at": "2026-10-25T20:10:00+08:00",
  "last_verified_at": "2026-10-25T20:10:00+08:00",
  "expires_at": null,
  "supersedes": [],
  "superseded_by": null,
  "closure_reason": null,
  "policy_effect": "none",
  "priority": 60,
  "tags": ["style", "communication"],
  "endogenous": false
}
```

### 3.2 protocol

```json
{
  "id": "mem-20261025-c3d4",
  "kind": "protocol",
  "status": "active",
  "scope": "global",
  "workspace": "",
  "owner": "user",
  "title": "清理目录前先列清单",
  "statement": "清理/删除目录前，先列出目录内容并保留目录骨架；含可执行文件的目录逐项确认。",
  "applies_when": ["清理目录", "删除文件", "释放空间"],
  "does_not_apply_when": ["用户已给出完整删除清单并明确确认整目录删除"],
  "evidence": [{"type": "session", "ref": "2026-10-25 清理旧版 DSH", "note": "用户事后纠正"}],
  "disconfirmation": "用户明确要求不列清单直接整目录删除，并已确认风险时，此条不适用。",
  "confidence": 0.9,
  "created_at": "2026-10-25T20:10:00+08:00",
  "last_verified_at": "2026-10-25T20:10:00+08:00",
  "expires_at": "2027-01-25T00:00:00+08:00",
  "supersedes": [],
  "superseded_by": null,
  "closure_reason": null,
  "policy_effect": "check",
  "priority": 80,
  "tags": ["safety", "filesystem"],
  "endogenous": false,
  "context_tags": ["cleanup", "delete", "filesystem"],
  "evidence_ids": ["session:2026-10-25-cleanup"]
}
```

### 3.3 thread

```json
{
  "id": "mem-20261025-e5f6",
  "kind": "thread",
  "status": "active",
  "scope": "workspace",
  "workspace": "D:\\DSH",
  "owner": "agent",
  "title": "官方清理后的 profile 是否还需要迁移",
  "statement": "官方 0.2.1-rc.3 的 desktop profile 已清理，但尚未验证跨版本迁移边界。",
  "open_question": "旧会话在新 profile 下是否全部可读，是否需要额外迁移？",
  "thread_status": "unresolved",
  "closure_reason": null,
  "lineage": {"parent_ids": [], "child_ids": []},
  "applies_when": ["处理 DSH 历史会话/迁移"],
  "does_not_apply_when": ["仅做新会话任务"],
  "evidence": [{"type": "file", "ref": "D:\\DSH\\logs\\official-cleanup-report.md", "note": "清理记录"}],
  "disconfirmation": "若新会话能正常列出并打开全部旧会话，此线索可标记 resolved。",
  "confidence": 0.7,
  "created_at": "2026-10-25T20:10:00+08:00",
  "last_verified_at": "2026-10-25T20:10:00+08:00",
  "expires_at": "2026-11-25T00:00:00+08:00",
  "supersedes": [],
  "superseded_by": null,
  "policy_effect": "none",
  "priority": 40,
  "tags": ["dsh", "migration"],
  "endogenous": false
}
```

### 3.4 handoff

```json
{
  "id": "mem-20261025-g7h8",
  "kind": "handoff",
  "status": "active",
  "scope": "workspace",
  "workspace": "D:\\DSH",
  "owner": "agent",
  "title": "记忆契约 v2 落地",
  "statement": "记忆契约、账本、校验器已写入；插件待安装/重启验证。",
  "task_id": "dsh-memory-v2",
  "goal": "把 ACCF/Twig 的有效字段合并进 DSH 记忆契约并落地",
  "stage": "contract-written",
  "next_action": "安装 dsh-memory-ledger 插件并重启客户端验证",
  "unknowns": ["desktop profile 下工具是否正常注册", "重启后历史会话是否不受影响"],
  "applies_when": ["继续 DSH 记忆系统工作"],
  "does_not_apply_when": ["其他项目任务"],
  "evidence": [{"type": "file", "ref": "D:\\DSH\\AGENTS.md", "note": "契约 v2"}],
  "disconfirmation": "若插件安装/重启失败，此 handoff 的 next_action 改为回滚。",
  "confidence": 0.8,
  "created_at": "2026-10-25T20:10:00+08:00",
  "last_verified_at": "2026-10-25T20:10:00+08:00",
  "expires_at": "2026-11-08T00:00:00+08:00",
  "supersedes": [],
  "superseded_by": null,
  "policy_effect": "handoff",
  "priority": 70,
  "tags": ["dsh", "memory"],
  "endogenous": false
}
```

---

## 4. 怎么用

### 4.1 新增候选

让 DSH 把内容写成 `candidate`，字段按上面的表填；没有证据/disconfirmation 也可以先候选，但不能 active。

### 4.2 提升为 active

需要用户明确确认，并补齐证据、`disconfirmation`、`scope`、`applies_when`、`does_not_apply_when`。提升时把 `status` 改为 `active`，更新 `last_verified_at`。

### 4.3 取代

新条目写 `supersedes: ["旧 id"]`；旧条目改 `status: "superseded"`、`superseded_by: "新 id"`。不要合并正文，保留旧状态。

### 4.4 否决

用户说“这条不对/删掉”：改 `status: "contested"`，在 `closure_reason` 写 `user-vetoed`；不要删除证据。只有独立的新证据达到更高门槛，才以邀请语气再提一次。

### 4.5 插件召回

安装 `dsh-memory-ledger` 后，模型可以调用：

- `memory_recall({query, kind?, limit?})`：返回 active、未过期、confidence ≥ 0.5 的条目；带 `disconfirmation` / `does_not_apply_when` / `last_verified_at`。
- `memory_status()`：返回 active/candidate/contested/过期计数。

插件**不会**自动把记忆注入系统提示，也不会自动写入。它只是只读召回；是否使用由当前任务和现场证据决定。

### 4.6 校验

```powershell
node memory/validate-memory.mjs
```

校验项包括：必填字段、枚举、日期、证据、disconfirmation、confidence、supersede 链一致性、active 预算、人格定性警告。

---

## 5. 来源映射（ACCF / 衔枝 Twig）

| 本账本字段/规则 | 来源 | 用途 |
|---|---|---|
| `disconfirmation` | ACCF | 可证伪；没有它不能 active |
| `supersedes` / `superseded_by` / belief chain | ACCF / Hy-Memory | 取代而非合并，保留旧状态 |
| `status` 生命周期 | ACCF | active/superseded/absorbed/contested |
| `owner` / `scope` / `subject` | ACCF | 跨 owner/主体/项目不合并 |
| `priority` 仅排序 | Twig 龙脉值 / ACCF | 注意力权重，不决定是否记录 |
| `open_question` / `thread_status` / `closure_reason` / `lineage` | Twig | 未闭合线索与状态机 |
| `confidence`（conviction） | Twig | 置信分，被反证挑战后衰减 |
| `applies_when` / `does_not_apply_when` | Twig 去定性化 + 本契约 | 防过度泛化 |
| `policy_effect` | Twig belief/policy 解耦 | 记忆不能直接推出干预/降级 |
| `endogenous` | Twig | 系统自己干预催生的证据降权 |
| `handoff` 字段 | ACCF | 跨会话任务连续性 |
| `protocol` / `context_tags` / `evidence_ids` | ACCF | 有证据的做法，禁止无来源全局规则 |
| `contested` / 用户否决 | Twig | 用户最终解释权 |

### 刻意不采纳

- Twig 的 SILENT / avoidance_signal：对编码助手来说“沉默=回避”证据不足，容易把正常不提当成心理信号，增加过度谨慎。
- 人格/画像自动注入：会把“用户是 X”变成政策，正是 WorkBuddy 式污染的来源。
- 自动 L0–L3 蒸馏：在没有强审批和强证据前，先不做。
- 情绪层作为事实/权限依据：只保留语气参考。

---

## 6. 与现有 `error-correction-memory` skill 的关系

现有 skill 是全局、触发式加载的纠错记忆。建议：

- 只保留跨项目安全不变量；
- 项目特定教训迁移到本账本的 `workspace` 层；
- 每条加 `scope` / `disconfirmation` / `expires_at` / `does_not_apply_when`；
- 全局 skill 控制在 10 条以内，过期归档。

本账本不替代 skill；skill 负责“触发时提醒”，账本负责“结构化、可审计、可召回”。
