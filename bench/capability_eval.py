"""能力验证评测：在自造语料（capsets/*.json）上跑 dshmem，分能力出报告。

用法：python bench/capability_eval.py [--server http://127.0.0.1:8899/v1] [--only chaos]
前置：local_server.py 已就绪；每个 capset 首跑会 ingest（有幂等缓存）。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.stdout.reconfigure(encoding="utf-8")

from locomo_eval import LLM, DshMemMemory, judge_one, answer_one, PROVIDER_CONFIG  # noqa: E402

HERE = Path(__file__).resolve().parent
CAPSETS = HERE / "capsets"

SET_DESC = {
    "chaos": "抗幻觉（一半问题不存在于对话，gold=unknown）",
    "detective": "多跳侦探链（物体流转/最后接触者）",
    "causal": "因果时序（先后/间隔/跟进）",
    "social": "全局人物关系网",
}


def load_capset(name: str) -> dict:
    d = json.loads((CAPSETS / f"{name}.json").read_text(encoding="utf-8"))[0]
    return d


def reset_checkpoint(name: str) -> None:
    """重跑某能力集前清其增量文件（避免旧答案混入新分数）。"""
    out = HERE / "results" / f"capability_{name}.jsonl"
    if out.exists():
        out.unlink()
        print(f"cleared {out.name}")


async def run_set(llm: LLM, memory: DshMemMemory, name: str, data: dict, sem: asyncio.Semaphore) -> list[dict]:
    dialog = {
        "sample_id": data["sample_id"],
        "qa": data["qa"],
        "conversation": data["conversation"],
        "turns": [],  # dshmem 不需要 turns
    }
    rows = []
    lock = asyncio.Lock()

    async def one(qa):
        async with sem:
            for attempt in (1, 2):
                try:
                    answer, snippets = await answer_one(llm, memory, dialog, qa["question"])
                    score = await judge_one(llm, qa["question"], str(qa["answer"]), answer)
                    break
                except Exception as exc:
                    if attempt == 2:
                        raise
                    print(f"[{name}] retry after: {type(exc).__name__}", flush=True)
                    if hasattr(memory, "ensure_alive"):
                        await memory.ensure_alive()
                    await asyncio.sleep(15)
        row = {
            "set": name,
            "question": qa["question"],
            "gold": str(qa["answer"]),
            "answer": answer[:150],
            "score": score,
            "snippets": [s[:150] for s in snippets],
        }
        async with lock:
            rows.append(row)
            out = HERE / "results" / f"capability_{name}.jsonl"
            with out.open("a", encoding="utf-8") as f:
                f.write(json.dumps(row, ensure_ascii=False) + "\n")
        return row

    return await asyncio.gather(*(one(qa) for qa in data["qa"]))


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", type=str, default="")
    parser.add_argument("--rerun", action="store_true", help="清空该能力集的增量文件后重跑")
    args = parser.parse_args()

    llm = LLM(PROVIDER_CONFIG)
    memory = DshMemMemory(k=4, use_semantic=True, do_ingest=True)
    health = await memory.start()
    print(f"[bridge] {memory.base} facts={health.get('facts')}", flush=True)

    names = [args.only] if args.only else list(SET_DESC)
    sem = asyncio.Semaphore(1)
    report = {}
    for name in names:
        if args.rerun:
            reset_checkpoint(name)
        data = load_capset(name)
        t0 = time.time()
        rows = await run_set(llm, memory, name, data, sem)
        mean = statistics.mean(r["score"] for r in rows)
        report[name] = mean
        print(f"\n== {name}（{SET_DESC[name]}）: {mean:.3f}（{time.time()-t0:.0f}s, {len(rows)} 题）", flush=True)
        for r in rows:
            flag = "OK " if r["score"] >= 0.8 else "LOW"
            print(f"  [{flag}{r['score']:.1f}] {r['question'][:60]}")
            if r["score"] < 0.8:
                print(f"        gold: {r['gold'][:80]}")
                print(f"        ans : {r['answer'][:80]}")

    print("\n=== 能力验证报告（每维独立达标线 0.85） ===")
    all_ok = True
    for name, mean in report.items():
        status = "PASS" if mean >= 0.85 else "FAIL"
        if mean < 0.85:
            all_ok = False
        print(f"  {name:10s} {mean:.3f} {status}")
    print("  总判定:", "全部通过" if all_ok else "存在未达标维度")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
