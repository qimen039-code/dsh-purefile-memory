"""LoCoMo 评测用 OpenAI 兼容推理服务（海光 DCU / Qwen3.5-4B + qwen35_adapter official 变体）。

部署：scp loco_server.py scnet:/root/loco_server.py
启动：ssh scnet ". /opt/hyhal/env.sh; . /opt/dtk-26.04/env.sh; nohup python /root/loco_server.py > /root/loco_server.log 2>&1 &"
端点：GET /health；POST /v1/chat/completions（temperature=0 → 贪心；串行锁）
"""
from __future__ import annotations

import asyncio
import pathlib
import time

import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from transformers import AutoTokenizer

import sys
sys.path.insert(0, "/root")
sys.stdout.reconfigure(encoding="utf-8")
import qwen35_adapter as ad  # noqa: E402

MODEL_DIR = pathlib.Path("/root/models/qwen3.5-4b")
app = FastAPI()
STATE = {"model": None, "tok": None, "ready": False, "name": "qwen3.5-4b", "lock": None}


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    model: str | None = None
    messages: list[ChatMessage]
    max_tokens: int | None = 512
    temperature: float | None = 0.0


def load() -> None:
    print(f"[server] loading {MODEL_DIR} (official variant, bf16)...", flush=True)
    tok = AutoTokenizer.from_pretrained(MODEL_DIR)
    model = ad.build_model(MODEL_DIR, "official", device="cuda")
    model.eval()
    STATE["model"] = (model, tok)
    STATE["tok"] = tok
    STATE["ready"] = True
    print("[server] ready", flush=True)


@app.get("/health")
async def health():
    return {"ok": True, "model": STATE["name"], "ready": STATE["ready"]}


@app.post("/v1/chat/completions")
async def chat(req: ChatRequest):
    if not STATE["ready"]:
        raise HTTPException(status_code=503, detail="model not ready")
    model, tok = STATE["model"]
    messages = [{"role": m.role, "content": m.content} for m in req.messages]
    try:
        prompt = tok.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=True, enable_thinking=False,
        )
    except TypeError:
        prompt = tok.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    inputs = tok(prompt, return_tensors="pt").to(model.device)
    prompt_tokens = int(inputs["input_ids"].shape[1])
    if prompt_tokens > 24000:
        raise HTTPException(status_code=413, detail=f"prompt too long: {prompt_tokens}")
    max_new = max(8, min(int(req.max_tokens or 512), 2048))
    greedy = (req.temperature or 0) < 0.01

    async with STATE["lock"]:
        loop = asyncio.get_running_loop()

        def generate():
            t0 = time.time()
            with torch.inference_mode():
                out = model.generate(
                    **inputs,
                    max_new_tokens=max_new,
                    do_sample=not greedy,
                    temperature=None if greedy else float(req.temperature),
                    top_p=None if greedy else 0.9,
                    pad_token_id=tok.eos_token_id,
                    stop_strings=["\nuser", "\nUser", "\nsystem", "\nassistant"],
                    tokenizer=tok,
                )
            text = tok.decode(out[0][prompt_tokens:], skip_special_tokens=True)
            # 思考兜底：万一模板没关干净，剥掉 think 段
            if "</think>" in text:
                text = text.split("</think>", 1)[1].strip()
            n = int(out.shape[1] - prompt_tokens)
            dt = time.time() - t0
            print(f"[server] {prompt_tokens}+{n} tok in {dt:.1f}s ({n/max(dt,0.1):.1f} tok/s)", flush=True)
            return text, n, dt

        try:
            text, n, dt = await loop.run_in_executor(None, generate)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=str(exc)) from exc

    return {
        "id": f"loco-{time.time_ns()}",
        "object": "chat.completion",
        "model": STATE["name"],
        "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": prompt_tokens, "completion_tokens": n, "total_tokens": prompt_tokens + n},
        "timings": {"seconds": round(dt, 2)},
    }


if __name__ == "__main__":
    import uvicorn

    STATE["lock"] = asyncio.Lock()
    import threading
    threading.Thread(target=load, daemon=True).start()
    uvicorn.run(app, host="127.0.0.1", port=8899, log_level="warning")
