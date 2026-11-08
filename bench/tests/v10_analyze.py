# -*- coding: utf-8 -*-
"""v10 合并评测·免费指标（纯本地计算，不调 LLM、不改任何文件）：
1) 证据供给率 recall@k：gold 答案的词项是否出现在召回的 top-k 片段里（按类别分解）
2) 启发式 used-rate：答案与各片段的词项重叠（送达后被"使用"的比例）
3) 弃答正确性：回答为「不知道」类的题目上，gold 是否也为未提及类
输出到 stdout。"""
import json, io, re, statistics, sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
RESULTS = Path(r"C:\Users\绮梦\.zcode\workspace\default\bench\results")

def toks(s):
    return set(w for w in re.findall(r"[a-z0-9]+", str(s).lower()) if len(w) >= 3)

def main():
    # v10 最终结果文件（locomo_*-local-full-v10.json）或 checkpoint
    cands = sorted(RESULTS.glob("locomo_*local-full-v10*.json"))
    if cands:
        rows = json.loads(cands[-1].read_text(encoding="utf-8"))
        print("source:", cands[-1].name)
    else:
        rows = [json.loads(l) for l in io.open(
            RESULTS / "checkpoint_local-full-v10-dshmem.jsonl", encoding="utf-8") if l.strip()]
        print("source: checkpoint")
    print("rows:", len(rows))

    recall_hits, used_fracs, abstain_ok, abstain_total = [], [], [], []
    by_cat_recall, by_cat_n = {}, {}
    NA_PAT = re.compile(r"不知道|未提及|没有提到|not mention|don't know|do not know|no information", re.I)
    for r in rows:
        gold_t = toks(r.get("gold") or "")
        snips = [toks(s) for s in (r.get("snippets") or [])]
        ans_t = toks(r.get("answer") or "")
        # recall@k：gold 词项 >=60% 出现在某一片段
        hit = 0
        if gold_t:
            for st in snips:
                if len(gold_t & st) >= 0.6 * len(gold_t):
                    hit = 1
                    break
            recall_hits.append(hit)
            by_cat_recall.setdefault(r["category"], []).append(hit)
        # used-rate：被答案使用的片段占比
        if snips:
            used = sum(1 for st in snips if len(ans_t & st) >= 3)
            used_fracs.append(used / len(snips))
        # 弃答正确性
        ans = str(r.get("answer") or "")
        if NA_PAT.search(ans):
            abstain_total.append(1)
            gold = str(r.get("gold") or "")
            abstain_ok.append(1 if NA_PAT.search(gold) or len(gold_t) <= 2 else 0)

    n = len(recall_hits)
    print(f"\n== 证据供给率 recall@k（gold 词项>=60% 命中某片段）==")
    print(f"overall: {statistics.mean(recall_hits):.3f}  (n={n})")
    CAT = {0: "single-hop", 1: "multi-hop", 2: "temporal", 3: "open-domain", 4: "adversarial", 5: "adversarial"}
    for cat in sorted(by_cat_recall):
        print(f"  cat{cat} {CAT.get(cat,'?'):12s}: {statistics.mean(by_cat_recall[cat]):.3f} (n={len(by_cat_recall[cat])})")
    if used_fracs:
        print(f"\n== 启发式 used-rate（答案使用的片段/送达片段）== {statistics.mean(used_fracs):.3f}")
    if abstain_total:
        print(f"== 弃答正确率（答「不知道」时 gold 确实未提及）== {statistics.mean(abstain_ok):.3f}  (n={len(abstain_total)})")

    print(f"\n== LoCoMo 回归总分（同尺 judge）== {statistics.mean(r['score'] for r in rows):.4f}  (n={len(rows)})")
    by_sys = {}
    for r in rows:
        by_sys.setdefault(r["system"], []).append(r["score"])
    for s, v in sorted(by_sys.items()):
        print(f"  {s}: {statistics.mean(v):.4f} (n={len(v)})")

if __name__ == "__main__":
    main()
