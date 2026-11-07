# 分层记忆系统 · 工具与运维

契约见 [`../SYSTEM.md`](../SYSTEM.md)，AI 短协议见 [`PROTOCOL.md`](PROTOCOL.md)，技能包随部署目录提供（可选）。

## 1. 入口

```powershell
$node = "node"   # 或设 MEM_NODE 指向自定义 node 可执行文件
$mem  = "<仓库根>\memory\system\bin\mem.mjs"

& $node $mem help
& $node $mem stats
& $node $mem doctor
```

也可以直接用包装器（自动找 `MEM_NODE` / DSH runtime node / PATH node）：

```powershell
& memory\system\bin\mem.cmd stats
& memory\system\bin\mem.cmd recall "<主题>"
```

`mem.ps1` 也可用，但受 PowerShell ExecutionPolicy 限制时需：
`pwsh -ExecutionPolicy Bypass -File memory\system\bin\mem.ps1 stats`。

无第三方依赖；需要 `zstd` 读取 DSH 会话（可设 `MEM_ZSTD` 指定 zstd 可执行文件路径）。

## 2. 目录

| 路径 | 作用 |
|---|---|
| `records/YYYY/MM/<id>/` | canonical 记录；封存/唤醒不移动 |
| `sessions/<workspace>/` | 会话卡（派生，可重建） |
| `index/catalog.json` | L0 召回索引 |
| `index/sessions.json` | 会话卡索引 |
| `index/injection.json` | brief 去重账本 |
| `views/` | HOT / ARCHIVE / SESSIONS / MAP 视图 |
| `inbox/` | 待整理草稿，不是 canonical |
| `cache/` | 可重建缓存 |

## 3. 读取命令

```powershell
# L0 召回（默认不读 L1）
& $node $mem recall "ACCF 隔离" --k 5
& $node $mem recall "记忆系统" --all-workspaces --include-sealed
& $node $mem recall "query" --deep        # 对短名单加读 L1

# 写前查重/相似（只读，不自动改）
& $node $mem check "ACCF 隔离"
& $node $mem check --title "新结论" --gist "新结论全文" --exclude rec-...

# 记录
& $node $mem list --temperature hot
& $node $mem show rec-...
& $node $mem chain rec-...            # supersedes / superseded_by 链
& $node $mem route rec-... --layer l1 --open
& $node $mem route rec-... --layer l2 --category artifacts --open
& $node $mem route rec-... --layer l2 --category notes --paths
& $node $mem route "mem://rec-.../l2/artifacts" --open
& $node $mem route "mem://rec-.../l3/notes"
& $node $mem route rec-... --layer l3 --category transcripts
& $node $mem route rec-... --layer audit --file corrections.jsonl

# 热记忆 delta
& $node $mem brief --session auto
& $node $mem brief --session auto --full

# recall 快照（审计；不自动创建、不自动注入）
& $node $mem view "ACCF 隔离" --k 5
& $node $mem view list
& $node $mem view show view-...
& $node $mem view prune --keep 50

# 候选记忆（不写 canonical；promote 才落记录）
& $node $mem inbox list
& $node $mem inbox add --title "草稿标题" --gist "草稿摘要" --kind project
& $node $mem inbox add --from-session 441ffb80
& $node $mem inbox update inbox-... --title "改后标题" --gist "改后摘要" --kind decision
& $node $mem inbox promote inbox-...
& $node $mem inbox promote inbox-... --force  # 允许同标题重复（默认拒绝）
& $node $mem inbox drop inbox-...

# 会话（跨项目）
& $node $mem session index
& $node $mem session list --limit 30
& $node $mem session find "ACCF"
& $node $mem session show 441ffb80 --last 3
& $node $mem session show 441ffb80 --turn 11 --full
& $node $mem session context 441ffb80 --last 3
& $node $mem session link 441ffb80

# 计数/校验
& $node $mem stats
& $node $mem doctor
& $node $mem config
```

`route` 的 `--path` 只输出路径；`--json` 输出结构化结果（含 content）。

## 4. 写入命令

### 新建记录

```powershell
& $node $mem new `
  --title "任务名" `
  --gist "一句话：这是什么、为什么值得打开" `
  --kind episode `
  --workspace <仓库根> `
  --tags dsh,memory `
  --key "关键结论 1" --key "关键结论 2" `
  --open "未闭合问题" `
  --session session-xxxx `
  --confidence 0.8
```

`--from-session <id>` 会从会话卡自动带标题/gist/key_points/session_ref。
`--digest-file <md>` 可直接给 L1。
写前查重统一用 `mem check`（`new` 不再自动打印相似提示）。

### 写 L1

```powershell
& $node $mem digest rec-... --file summary.md
& $node $mem digest rec-... --text "..."
```

L1 ≤6000 字符；封存前 ≥300 字符。改写前自动存 `versions/`。

### 写 L2

```powershell
& $node $mem index-set rec-... --file index.json
```

`index.json` 至少包含（完整 schema 见 `system/schemas/index.schema.json`）：

```json
{
  "schema": 1,
  "record_id": "rec-...",
  "generated_at": "2026-10-26T18:00:00+08:00",
  "categories": {
    "sessions": [], "artifacts": [], "sources": [], "logs": [],
    "decisions": [], "related_records": [], "claims": [], "notes": []
  },
  "locators": []
}
```

### 更新/封存/唤醒

```powershell
& $node $mem update rec-... --tags-add foo --key "新增要点" --open "新问题"
& $node $mem update rec-... --close-loop "问题关键词"
& $node $mem update rec-... --reviewed
& $node $mem seal rec-...            # 要求 digest 足够且无未闭合
& $node $mem seal rec-... --force
& $node $mem wake rec-... --hot
& $node $mem touch rec-...
```

### 取代（核心）

```powershell
& $node $mem supersede rec-old `
  --title "新结论" `
  --gist "一句话新结论" `
  --digest-file new.md `
  --why "新证据/用户更正"
```

效果：

- 新建一个独立记录（不复制旧正文）；
- 旧记录 `standing=superseded`、`superseded_by=新 id`；
- 新记录 `relations` 含 `supersedes`；
- 默认 recall/brief 不再返回旧记录；`--history` 可查；`mem chain <id>` 可看完整结论链。

### 修正/反证/否决

```powershell
& $node $mem annotate rec-... --kind correction --text "修正细节" --evidence "session-..."
& $node $mem annotate rec-... --kind counter_evidence --text "发现反证"
& $node $mem annotate rec-... --veto --text "用户否决"
```

原文不改；`audit/corrections.jsonl` 追加；L1 末尾追加“修正记录”；`user_veto` 会设 `standing=contested`、`temperature=frozen`。

### 链接

```powershell
& $node $mem link rec-a related_to rec-b --why "同一项目"
& $node $mem link rec-thread thread_of rec-episode
```

双向写入；`supersedes/superseded_by` 不允许用 `link`，必须用 `supersede`。

## 5. 维护

```powershell
& $node $mem reindex --sessions   # 重建 catalog + sessions + views + retrieval.db
& $node $mem index-build          # 只重建 FTS5/BM25 派生索引；写记录后索引过期时用
& $node $mem doctor               # 0 error 才健康；warning 逐条看
& $node $mem selftest             # 临时目录端到端自测
& $node test\run-all.mjs          # selftest + FTS + bridge/plugin 全量烟测
& $node $mem sweep                # 可封存/待复核/未 reviewed
```

`recall` 在 `index/retrieval.db` 新鲜时走 FTS5 候选 + 原 L0 评分；索引缺失或过期时自动回退 `catalog.json` 全扫基线，不会因索引问题阻塞读取。`doctor` 会提示过期索引。`doctor` 检查：schema/必填字段、id 与目录、digest 预算、sealed 门槛、relations、supersede 双向链、会话索引/transcript、claim active 预算、zstd，以及 `meta.integrity` 的 digest/index hash。

## 6. 配置

`system/config.json` 可改：

- `budgets`：gist/L1/brief/recall 上限
- `lifecycle`：hot/warm/seal/review 天数、封存最小 digest、hot 上限
- `recall`：是否默认含 sealed、sealed 惩罚、每项目上限、deepTopN
- `sessionsRoot` / `projectionRoot`：DSH 会话与投影缓存位置
- `zstd`：zstd 可执行文件路径

环境变量覆盖：`MEM_ROOT`、`MEM_CONFIG`、`MEM_SESSIONS_ROOT`、`MEM_PROJECTION_ROOT`、`MEM_WORKSPACE`、`MEM_ZSTD`。

## 7. DSH 插件（可选）

部署目录中的 `plugins/dsh-memory-vault`（可选）提供只读工具：

- `mem_recall`
- `mem_route`
- `mem_brief`
- `mem_session`
- `mem_status`

安装到 profile 后重启 DSH 生效；未安装时用上面的 CLI。插件不自动写入、不自动注入正文。

## 8. 排错

| 现象 | 处理 |
|---|---|
| `找不到 zstd` | 安装 zstd / 设 `MEM_ZSTD` / 改 `config.zstd` |
| `catalog 不一致` | `mem reindex` |
| `session 索引不一致` | `mem session index` |
| `route` 找不到记录 | 先 `mem recall`；id 至少 6 位前缀 |
| `seal` 被拒 | 补 L1 到 ≥300 字符、关闭未闭合，或 `--force` |
| `digest` 超预算 | 压到 6000 字符内；细节放 L2/L3 |
| 写入后记录不出现 | `mem reindex`；检查 `doctor` |
