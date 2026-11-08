# -*- coding: utf-8 -*-
"""固定-judge 离线重判（v10 版）：对 locomo_*local-full-v10*.json 的每条答案，
用当前 8899 端口已加载的 judge 模型按 harness 自身 JUDGE_SYS 协议重打分。
复用 locomo_eval 的 LLM 与 judge_one；不修改任何原始文件。"""
import asyncio, json, statistics, sys, time
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.path.insert(0, r"C:\Users\绮梦\.zcode\workspace\default\bench")
from locomo_eval import LLM, PROVIDER_CONFIG, judge_one  # noqa: E402

RESULTS = Path(r"C:\Users\绮梦\.zcode\workspace\default\bench\results")


async def main():
    files = sorted(RESULTS.glob("locomo_*local-full-v10*.json"))
    if not files:
        raise SystemExit("no v10 result files found")
    llm = LLM(PROVIDER_CONFIG)
    out = {}
    for f in files:
        rows = json.loads(f.read_text(encoding="utf-8"))
        judged, olds, news = [], [], []
        for i, row in enumerate(rows):
            ns = await judge_one(llm, row["question"], row["gold"], row["answer"])
            judged.append({
                "sample_id": row["sample_id"], "category": row["category"],
                "system": row["system"], "old_score": row["score"], "new_score": ns,
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
    outpath = RESULTS / f"v10_rejudge_{stamp}.json"
    outpath.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print("written:", outpath)


if __name__ == "__main__":
    asyncio.run(main())
