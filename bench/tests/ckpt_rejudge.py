# -*- coding: utf-8 -*-
"""固定-judge 重判（checkpoint 版）：对所有 checkpoint_mi-*-dshmem.jsonl 的每行答案
用当前 8899 端口 judge 模型按 harness 协议重打分。跨模型比较以本文件输出为准
（原生同源 judge 对弱模型显著自宽，见 mi-smol 0.922→0.389）。"""
import asyncio, json, statistics, sys, time
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.path.insert(0, r"C:\Users\绮梦\.zcode\workspace\default\bench")
from locomo_eval import LLM, PROVIDER_CONFIG, judge_one  # noqa: E402

RESULTS = Path(r"C:\Users\绮梦\.zcode\workspace\default\bench\results")


async def main():
    files = sorted(RESULTS.glob("checkpoint_mi-*.jsonl"))
    if not files:
        raise SystemExit("no checkpoint_mi files")
    llm = LLM(PROVIDER_CONFIG)
    out = {}
    for f in files:
        rows = [json.loads(l) for l in f.read_text(encoding="utf-8").splitlines() if l.strip()]
        judged, olds, news = [], [], []
        for i, row in enumerate(rows):
            ns = await judge_one(llm, row["question"], row["gold"], row["answer"])
            judged.append({
                "sample_id": row["sample_id"], "category": row["category"],
                "old_score": row["score"], "new_score": ns,
            })
            olds.append(row["score"]); news.append(ns)
            if (i + 1) % 40 == 0:
                print(f"{f.name}: {i+1}/{len(rows)}", flush=True)
        out[f.name] = {
            "n": len(rows),
            "mean_old": statistics.mean(olds), "mean_new": statistics.mean(news),
            "rows": judged,
        }
        print(f"{f.name}: old={out[f.name]['mean_old']:.3f} new={out[f.name]['mean_new']:.3f}", flush=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    outpath = RESULTS / f"mi_ckpt_rejudge_{stamp}.json"
    outpath.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print("written:", outpath)


if __name__ == "__main__":
    asyncio.run(main())
