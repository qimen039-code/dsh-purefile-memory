"""LoCoMo 记忆评测（工作区版）：已部署 DSH 记忆系统 vs full-context 基线，同协议对比。

协议（与 fatfish 版逐字一致，保证横向可比）：
    ingest 全对话 → 分层抽样 QA → 各系统召回 top-k → 本地模型生成（temp=0）
    → 本地模型 judge 打分（1-5，归一化到 0-1）。

模型与成本：
  - 全链路（抽取/重排摘要/扩展/生成/judge）默认走 bench/provider.json 指定的本地
    OpenAI 兼容服务（bench/local_server.py，零 API 成本、可复现）。
  - 不再依赖任何付费 API；如需用别的端点改 provider.json 即可。

用法：
    python bench/locomo_eval.py [--systems dshmem,full] [--limit-dialogs 0] [--per-cat 6]
                                [--k 4] [--tag dev] [--no-ingest]
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import statistics
import subprocess
import sys
import time
from collections import defaultdict
from datetime import datetime
from pathlib import Path

import httpx

HERE = Path(__file__).resolve().parent
LOCOMO = HERE / "locomo10.json"
BRIDGE = HERE / "dshmem_bridge.mjs"
PROVIDER_CONFIG = HERE / "provider.json"

CAT_NAMES = {1: "single-hop", 2: "temporal", 3: "multi-hop", 4: "open-domain", 5: "adversarial"}
ANSWER_SYS = (
    "你是助手。只根据给出的记忆片段回答问题；片段里没有的信息就回答「不知道」，不要编造。回答尽量简短（一两句话）。"
)
FULL_SYS = "你是助手。根据完整对话记录回答问题；记录里没有的就回答「不知道」。回答尽量简短（一两句话）。"
JUDGE_SYS = (
    "你是评分器。给定问题、标准答案、系统回答，按 1-5 打分："
    "5=完全正确；4=基本正确有小瑕疵；3=部分正确；2=方向对但大部分错误；1=错误或编造。"
    "关键规则：只有当【标准答案】本身表示「对话中未提及/未提到/无相关信息」时，系统回答「不知道/未提及」才判 5；"
    "若【标准答案】是具体内容（人名/地点/数字/事件等），而系统回答「不知道/未提及」，必须判 1 或 2（这是错误弃答，不是正确拒答）。"
    "不要因为系统回答谦虚或谨慎就给高分；评分只看系统回答与标准答案的实质一致性。"
    '只输出 JSON：{"score": 1到5的整数}'
)


# ---------------------------------------------------------------- data
def load_dialogs() -> list[dict]:
    data = json.loads(LOCOMO.read_text(encoding="utf-8"))
    out = []
    for d in data:
        conv = d["conversation"]
        turns = []
        session_keys = sorted(
            (k for k in conv if re.match(r"session_\d+$", k)),
            key=lambda k: int(k.split("_")[1]),
        )
        for key in session_keys:
            date_time = conv.get(f"{key}_date_time", "")
            raw = conv[key]
            turns_raw = json.loads(raw) if isinstance(raw, str) else raw
            for t in turns_raw:
                turns.append(
                    {
                        "speaker": t.get("speaker") or "??",
                        "text": (t.get("text") or "").strip(),
                        "dt": date_time,
                    }
                )
        out.append(
            {
                "sample_id": d["sample_id"],
                "turns": turns,
                "qa": d["qa"],
                "conversation": conv,
            }
        )
    return out


def sample_qa(dialog: dict, per_cat: int) -> list[dict]:
    by_cat: dict[int, list[dict]] = defaultdict(list)
    for q in dialog["qa"]:
        by_cat[q["category"]].append(q)
    picked: list[dict] = []
    for cat in sorted(by_cat):
        picked.extend(by_cat[cat][:per_cat])
    return picked


# ---------------------------------------------------------------- llm
class LLM:
    def __init__(self, cfg_path: Path):
        prov = json.loads(cfg_path.read_text(encoding="utf-8"))
        self.base_url = prov["baseUrl"].rstrip("/")
        self.model = prov.get("model") or "local"
        self.api_key = prov.get("apiKey") or "local"
        self.calls = 0
        self.errors = 0
        # 本地模型较慢：单次调用放宽到 10 分钟。
        self._client = httpx.AsyncClient(timeout=600)

    async def chat(self, messages, max_tokens: int, temperature: float = 0.0, json_mode: bool = False):
        payload = {
            "model": self.model,
            "messages": messages,
            "max_tokens": max_tokens,
            "stream": False,
            "temperature": temperature,
        }
        if json_mode:
            # 本地小模型对 response_format 支持不稳：改为在提问里强调只输出 JSON，
            # 解析侧已有宽松 JSON 提取兜底。
            messages = list(messages)
            messages[-1] = dict(messages[-1])
            messages[-1]["content"] += "\n（只输出一个 JSON 对象，不要输出其他文字。）"
        self.calls += 1
        delay = 5.0
        for attempt in range(9):
            try:
                resp = await self._client.post(
                    f"{self.base_url}/chat/completions",
                    headers={"Authorization": f"Bearer {self.api_key}"},
                    json=payload,
                )
                if resp.status_code == 429 or resp.status_code >= 500:
                    await asyncio.sleep(delay)
                    delay = min(delay * 2, 45)
                    continue
                if resp.status_code >= 400:
                    self.errors += 1
                    raise RuntimeError(f"llm {resp.status_code}: {resp.text[:200]}")
                data = resp.json()
                return (data["choices"][0]["message"]["content"] or "").strip()
            except (httpx.TimeoutException, httpx.TransportError):
                if attempt == 8:
                    self.errors += 1
                    raise
                await asyncio.sleep(delay)
                delay = min(delay * 2, 45)
        self.errors += 1
        raise RuntimeError("llm retries exhausted")


# ---------------------------------------------------------------- systems
class DshMemMemory:
    """本工作区部署的 DSH 分层记忆系统（经 HTTP 桥接；桥死亡自动重启）。"""

    kind = "dshmem"

    def __init__(self, k: int = 4, use_semantic: bool = True, do_ingest: bool = True):
        self.proc: subprocess.Popen | None = None
        self.base: str | None = None
        self.k = k
        self.use_semantic = use_semantic
        self.do_ingest = do_ingest
        self.ingested: set[str] = set()
        self.ingest_locks: dict[str, asyncio.Lock] = {}
        self.abstained = 0
        self.health_url = None

    async def start(self) -> dict:
        env = dict(os.environ)
        self.proc = subprocess.Popen(
            ["node", str(BRIDGE), "--config", str(HERE / "config.json"), "--port", "0"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            cwd=str(HERE),
            env=env,
        )
        line = self.proc.stdout.readline()
        info = json.loads(line)
        self.base = f"http://127.0.0.1:{info['port']}"
        self.health_url = f"{self.base}/health"
        async with httpx.AsyncClient(timeout=30) as client:
            return (await client.get(self.health_url)).json()

    async def ensure_alive(self) -> None:
        """桥进程被外部杀死时自动重启（本机上 node/python 都会被周期性杀）。"""
        if self.health_url:
            try:
                async with httpx.AsyncClient(timeout=4) as client:
                    resp = await client.get(self.health_url)
                if resp.status_code == 200:
                    return
            except Exception:
                pass
        print("[bridge] 桥失联，自动重启…", flush=True)
        if self.proc is not None:
            try:
                self.proc.kill()
            except Exception:
                pass
        for attempt in range(3):
            try:
                await self.start()
                print(f"[bridge] 重启成功 {self.base}", flush=True)
                return
            except Exception as exc:
                print(f"[bridge] 重启失败（{attempt + 1}/3）：{exc}", flush=True)
                await asyncio.sleep(10)
        raise RuntimeError("bridge restart failed")

    async def _post(self, path: str, payload: dict, timeout: float = 900) -> dict:
        delay = 3.0
        last = None
        for attempt in range(4):
            try:
                async with httpx.AsyncClient(timeout=timeout) as client:
                    resp = await client.post(f"{self.base}{path}", json=payload)
                if resp.status_code < 500:
                    resp.raise_for_status()
                    return resp.json()
                last = httpx.HTTPStatusError(f"bridge {resp.status_code}", request=resp.request, response=resp)
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                last = exc
            await asyncio.sleep(delay)
            delay *= 2
        raise last

    async def ensure_ingest(self, dialog: dict) -> None:
        if not self.do_ingest or dialog["sample_id"] in self.ingested:
            return
        # 同一对话的并发问题只触发一次 ingest，避免重复 LLM 抽取与写库竞争。
        lock = self.ingest_locks.setdefault(dialog["sample_id"], asyncio.Lock())
        async with lock:
            if dialog["sample_id"] in self.ingested:
                return
            # 大对话的 LLM 事实抽取可达 30-60 分钟，必须超过桥接侧最慢路径，否则 ReadTimeout 会杀死整个评测。
            await self._post("/ingest", {"id": dialog["sample_id"], "dialog": dialog["conversation"]}, timeout=14400)
            self.ingested.add(dialog["sample_id"])

    async def recall(self, dialog: dict, question: str) -> list[str]:
        await self.ensure_ingest(dialog)
        data = await self._post("/recall", {
            "query": question,
            "dialog_id": dialog["sample_id"],
            "k": self.k,
            "semantic": self.use_semantic,
        })
        if data.get("abstained"):
            self.abstained += 1
        return data.get("snippets") or []


class FullContextMemory:
    """基线：不召回，整段对话塞进上下文。"""

    kind = "full"

    def __init__(self):
        self.transcripts: dict[str, str] = {}

    def ingest(self, dialog: dict) -> None:
        self.transcripts[dialog["sample_id"]] = "\n".join(
            f"{t['speaker']}: {t['text']}" for t in dialog["turns"]
        )

    def recall(self, dialog: dict, question: str) -> list[str]:
        return []


# ---------------------------------------------------------------- eval
async def answer_one(llm: LLM, memory, dialog: dict, question: str) -> tuple[str, list[str]]:
    if memory.kind == "full":
        messages = [
            {"role": "system", "content": FULL_SYS},
            {"role": "user", "content": f"【对话记录】\n{memory.transcripts[dialog['sample_id']]}\n\n【问题】{question}"},
        ]
        text = await llm.chat(messages, max_tokens=220, temperature=0.0)
        return text, []
    snippets = await memory.recall(dialog, question)
    snippet_text = "\n".join(f"- {s}" for s in snippets) if snippets else "（无相关片段）"
    messages = [
        {"role": "system", "content": ANSWER_SYS},
        {"role": "user", "content": f"【记忆片段】\n{snippet_text}\n\n【问题】{question}"},
    ]
    text = await llm.chat(messages, max_tokens=220, temperature=0.0)
    # Qwen3.5 模板泄漏兜底：生成越过轮次边界时剥掉 "user" 及其后内容。
    for stop in ("\nuser", "\nUser"):
        if stop in text:
            text = text.split(stop)[0].strip()
    return text, snippets


async def judge_one(llm: LLM, question: str, gold: str, answer: str) -> float:
    user = f"【问题】{question}\n【标准答案】{gold}\n【系统回答】{answer}"
    try:
        text = await llm.chat(
            [
                {"role": "system", "content": JUDGE_SYS},
                {"role": "user", "content": user},
            ],
            max_tokens=60,
            temperature=0.0,
            json_mode=True,
        )
        start, end = text.index("{"), text.rindex("}") + 1
        score = float(json.loads(text[start:end]).get("score", 1))
    except Exception:
        return 0.0
    return max(1.0, min(5.0, score)) / 5.0


def checkpoint_path(tag: str) -> Path:
    return HERE / "results" / f"checkpoint_{tag or 'default'}.jsonl"


def load_checkpoint(tag: str) -> dict:
    """断点续跑：返回 {(sample_id, question): row}。"""
    path = checkpoint_path(tag)
    done: dict = {}
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
                done[(row["sample_id"], row["question"])] = row
            except Exception:
                continue
    return done


def append_checkpoint(tag: str, row: dict) -> None:
    path = checkpoint_path(tag)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")


async def eval_system(llm: LLM, name: str, memory, tasks: list[dict], sem: asyncio.Semaphore,
                      done: dict | None = None, tag: str = "") -> list[dict]:
    if memory.kind == "full":
        for task in tasks:
            memory.ingest(task["dialog"])

    done = done or {}
    lock = asyncio.Lock()

    async def one(task):
        key = (task["sample_id"], task["question"][:60])
        if key in done:
            return done[key]
        async with sem:
            # 本机环境下 python/node 进程会被周期性外部杀死：
            # 第一次失败后尝试自愈（重启桥 / 等服务监督循环拉起）再重试一次。
            for attempt in (1, 2):
                try:
                    answer, snippets = await answer_one(llm, memory, task["dialog"], task["question"])
                    score = await judge_one(llm, task["question"], task["answer"], answer)
                    break
                except Exception as exc:
                    if attempt == 2:
                        raise
                    print(f"[{name}] 单题失败将自愈重试：{type(exc).__name__}: {str(exc)[:120]}", flush=True)
                    if hasattr(memory, "ensure_alive"):
                        await memory.ensure_alive()
                    await asyncio.sleep(20)
        row = {
            "system": name,
            "sample_id": task["sample_id"],
            "category": task["category"],
            "score": score,
            "question": task["question"][:60],
            "answer": answer[:120],
            "gold": task["answer"][:160],
            "snippets": [s[:200] for s in snippets],
        }
        async with lock:
            append_checkpoint(tag, row)
        return row

    return await asyncio.gather(*(one(t) for t in tasks))


async def start_bridge() -> tuple[subprocess.Popen, str, dict]:
    """旧入口，保留给手动调试；评测主流程使用 DshMemMemory.start()/ensure_alive()。"""
    env = dict(os.environ)
    proc = subprocess.Popen(
        ["node", str(BRIDGE), "--config", str(HERE / "config.json"), "--port", "0"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        cwd=str(HERE),
        env=env,
    )
    line = proc.stdout.readline()
    info = json.loads(line)
    base = f"http://127.0.0.1:{info['port']}"
    async with httpx.AsyncClient(timeout=30) as client:
        health = (await client.get(f"{base}/health")).json()
    return proc, base, health


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit-dialogs", type=int, default=0)
    parser.add_argument("--per-cat", type=int, default=6)
    parser.add_argument("--systems", type=str, default="dshmem,full")
    parser.add_argument("--k", type=int, default=4)
    parser.add_argument("--tag", type=str, default="")
    parser.add_argument("--no-ingest", action="store_true", help="桥接侧已有数据时跳过重复 ingest")
    parser.add_argument("--no-semantic", action="store_true", help="关闭语义重排（纯词面）")
    parser.add_argument("--out", type=str, default="")
    parser.add_argument("--fresh", action="store_true", help="忽略断点，全部重答")
    args = parser.parse_args()

    dialogs = load_dialogs()
    if args.limit_dialogs:
        dialogs = dialogs[: args.limit_dialogs]

    memories: dict[str, object] = {}
    if "dshmem" in args.systems.split(","):
        memory = DshMemMemory(k=args.k, use_semantic=not args.no_semantic, do_ingest=not args.no_ingest)
        health = await memory.start()
        print(f"[bridge] {memory.base} semantic={health.get('semantic')} facts={health.get('facts')}", flush=True)
        memories["dshmem"] = memory
    if "full" in args.systems.split(","):
        memories["full"] = FullContextMemory()

    tasks_by_system: dict[str, list[dict]] = defaultdict(list)
    for dialog in dialogs:
        qas = sample_qa(dialog, args.per_cat)
        for qa in qas:
            gold = qa.get("adversarial_answer") or qa.get("answer") or ""
            gold = str(gold)
            for name in memories:
                tasks_by_system[name].append(
                    {
                        "dialog": dialog,
                        "sample_id": dialog["sample_id"],
                        "question": qa["question"],
                        "answer": gold,
                        "category": qa["category"],
                    }
                )

    llm = LLM(PROVIDER_CONFIG)
    results: list[dict] = []
    sem = asyncio.Semaphore(1)

    for name, memory in memories.items():
        tasks = tasks_by_system[name]
        done = {} if args.fresh else load_checkpoint(f"{args.tag}-{name}")
        remaining = sum(1 for t in tasks if (t["sample_id"], t["question"][:60]) not in done)
        t0 = time.time()
        print(f"[{name}] 评测 {len(tasks)} 题（断点已完成 {len(done)}，待答 {remaining}）…", flush=True)
        rows = await eval_system(llm, name, memory, tasks, sem, done=done, tag=f"{args.tag}-{name}")
        results.extend(rows)
        mean = statistics.mean(r["score"] for r in rows)
        extra = f" 弃答 {getattr(memory, 'abstained', 0)} 次" if name == "dshmem" else ""
        print(f"[{name}] 完成，均值 {mean:.3f}（{time.time() - t0:.0f}s，llm calls={llm.calls}）{extra}", flush=True)

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    tag = f"-{args.tag}" if args.tag else ""
    out_path = Path(args.out) if args.out else HERE / "results" / f"locomo_{stamp}{tag}.json"
    out_path.write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")

    print("\n=== LoCoMo 评测结果（同 judge 同协议） ===")
    by_system: dict[str, list[dict]] = defaultdict(list)
    for r in results:
        by_system[r["system"]].append(r)
    for name, rows in sorted(by_system.items()):
        mean = statistics.mean(r["score"] for r in rows)
        print(f"\n{name}: 总分 {mean:.3f}  (n={len(rows)})")
        for cat in sorted({r["category"] for r in rows}):
            cat_rows = [r for r in rows if r["category"] == cat]
            print(f"  {CAT_NAMES.get(cat, cat):12s} {statistics.mean(r['score'] for r in cat_rows):.3f} (n={len(cat_rows)})")

    dshmem_memory = memories.get("dshmem")
    if dshmem_memory is not None and getattr(dshmem_memory, "proc", None) is not None:
        dshmem_memory.proc.terminate()
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
