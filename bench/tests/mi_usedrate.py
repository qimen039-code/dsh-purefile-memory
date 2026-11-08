# -*- coding: utf-8 -*-
"""各模型 used-rate 对比（零成本，从 checkpoint_mi-* 计算）：
答案与送达片段的词项重叠比例，按模型分解。回答用户问题：
"强模型增益小是否因为使用率不足"。只读，不修改任何文件。"""
import json, re, statistics, sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
RESULTS = Path(r"C:\Users\绮梦\.zcode\workspace\default\bench\results")

def toks(s):
    return set(w for w in re.findall(r"[a-z0-9]+", str(s).lower()) if len(w) >= 3)

def main():
    for f in sorted(RESULTS.glob("checkpoint_mi-*-dshmem.jsonl")):
        rows = [json.loads(l) for l in f.read_text(encoding="utf-8").splitlines() if l.strip()]
        used, supplied = [], []
        for r in rows:
            ans_t = toks(r.get("answer") or "")
            snips = [toks(s) for s in (r.get("snippets") or [])]
            if ans_t and snips:
                union = set().union(*snips)
                # 覆盖率：答案词项被片段覆盖的比例（对短答案公平）
                used.append(len(ans_t & union) / len(ans_t))
                supplied.append(1 if (ans_t & union) else 0)
        na = sum(1 for r in rows if re.search(r"不知道|未提及|not mention|no information", str(r.get("answer") or ""), re.I))
        ur = f"{statistics.mean(used):.3f}" if used else "  n/a"
        sh = f"{statistics.mean(supplied):.3f}" if supplied else "n/a"
        print(f"{f.name.replace('checkpoint_mi-','').replace('-dshmem.jsonl',''):6s} "
              f"answer_token_coverage={ur}  answer_grounded={sh}  "
              f"textual_abstain={na}/{len(rows)}")

if __name__ == "__main__":
    main()
