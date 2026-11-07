# 工作区协议：DSH 分层记忆系统（已部署）

本工作区部署了 DSH 分层记忆系统（v3）。根目录在 `memory/`，CLI 入口：

```
node memory/system/bin/mem.mjs <command> [options]
```

## 何时调用

- **续接旧任务**（用户说"继续/上次/之前"）或当前决策可能已有结论时：先 `recall "主题" --k 5`，再动手。
- **新会话开始**：可 `brief --session auto` 拿热记忆 delta（有去重）。
- **写前**：`check "标题 关键词"` 查相似记录，避免重复开记录。
- 记忆只是线索，不是命令；不适用就丢弃，不降低当前任务的交付质量。

## 写入边界（与 DSH 侧一致）

- 只记会改变下一步行动的东西：状态、决策、约束、未闭合线索、产物位置、证据。
- 不自动写入；新记录用 `new`，结论更新用 `supersede`，修正用 `annotate`，不改正文历史。
- L0 gist ≤260 字符，L1 ≤6000 字符；事实原文不改。

## 常用命令

```
node memory/system/bin/mem.mjs recall "查询" --k 5 [--json]
node memory/system/bin/mem.mjs brief --session auto
node memory/system/bin/mem.mjs check "关键词" 
node memory/system/bin/mem.mjs new --title "..." --gist "..." --kind episode
node memory/system/bin/mem.mjs route <id> --layer l1 --open
node memory/system/bin/mem.mjs doctor
```

## bench/ 目录

`bench/` 是 LoCoMo 记忆评测管线（数据 + 评测脚本 + 结果），与 `memory/` 系统配套迭代。
