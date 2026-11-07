# bench/ — LoCoMo 记忆评测管线

与 `memory/`（DSH 分层记忆系统）配套的评测设施（全程同 judge 同提示词同 k，横向可比）。

## 组件

| 文件 | 作用 |
|---|---|
| `locomo10.json` | LoCoMo 本地子集：10 个多会话对话、1991 题（评测抽样 per-cat 6 → 294 题） |
| `dshmem_bridge.mjs` | HTTP 桥接：`/ingest` `/recall` `/health`，调用 `memory/system/lib` 的事实层 |
| `locomo_eval.py` | 评测 harness：ingest → 抽样 QA → 召回 top-k → deepseek-flash 生成（temp=0）→ flash judge 1-5 归一 0-1 |
| `config.json` | bench 专用记忆库配置（root=memstore/，semantic 段） |
| `memstore/` | bench 独立的记忆存储（不影响 `memory/` 正式库） |
| `results/` | 每次评测的逐题结果（JSON/JSONL，含 gold/answer/snippets 快照） |

## 运行

```powershell
# LLM 端点由 bench/provider.json 指定（默认 http://127.0.0.1:8899/v1 本地模型）；
# 若使用云端 API，请通过环境变量注入密钥，不要写进任何文件
python bench/locomo_eval.py --systems dshmem,full --per-cat 6 --k 4          # 全量 10 对话
python bench/locomo_eval.py --limit-dialogs 2 --tag dev                     # dev 子集
python bench/locomo_eval.py --no-ingest                                     # 复用 memstore 缓存（事实抽取只做一次）
python bench/locomo_eval.py --no-semantic                                   # 纯词面召回（消融）
# 首次或抽取提示词变更后：删除 memstore/ 重新抽取（缓存可随时重建）
```

## 关键结论（2026-10-28）

- 旧 dsh-memory-ledger 词面复刻：**0.357**（10 对话 294 题）
- v3.1 事实层系统：**0.671–0.687**（配置敏感性见 results/full-v*）
- full-context 全知基线（同 judge）：**0.651–0.719，均值≈0.68** —— 这是本 harness 的 oracle 天花板
- judge（deepseek-flash）对"不知道+解释"类回答有运行间翻转：cat5 只有 29% 给满分，cat3 有 73%；单次评测噪声 σ≈0.025
- cat5（adversarial，20% 权重）的 gold 是"前提污染题"（人物/细节被调换）的内容词答案，
  fixed ANSWER_SYS 下的 flash 会因主体不匹配回答「不知道」→ 这是残余失分的最大来源（约 33 分/94 分总失分）

## API 故障记录

DeepSeek 平台在本窗口内出现两次账户级 401（所有 key 同时失效，~15 分钟后自愈）。
harness/桥接均已带 429/5xx/网络错误重试；`tests/wait_and_run_final.py` 是等待恢复后自动
跑最终评测的看门狗。
