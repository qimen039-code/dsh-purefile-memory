"""本地小模型推理服务（OpenAI 兼容子集），供 LoCoMo 评测全链路使用（零 API 成本）。

  python bench/local_server.py --model Qwen/Qwen3-4B-Instruct-2507 --port 8899

端点：
  GET  /health                  → {ok, model, ready}
  POST /v1/chat/completions     → OpenAI messages 协议子集（temperature/max_tokens/stop）
实现：
  - transformers + bitsandbytes 4bit（单卡 8GB 可容 4B-8B）
  - GPU 串行队列（asyncio lock），greedy 解码（temperature=0 → 可复现）
  - 忽略未知字段（thinking 等），response_format 仅透传提示（不做约束解码）
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
import time

import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig

os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
# 默认离线：模型一律用本地快照路径加载，避免任何联网探测。
os.environ.setdefault("HF_HUB_OFFLINE", "1")

app = FastAPI()
STATE = {"model": None, "ready": False, "lock": None, "name": ""}


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    model: str | None = None
    messages: list[ChatMessage]
    max_tokens: int | None = 512
    temperature: float | None = 0.0
    stop: list[str] | None = None


def load_model(model_id: str, quantized: bool = True) -> None:
    print(f"[server] loading {model_id} ({'4-bit' if quantized else 'bf16'}) ...", flush=True)
    tokenizer = AutoTokenizer.from_pretrained(model_id)
    kwargs = {}
    if quantized:
        kwargs["quantization_config"] = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=torch.bfloat16,
            bnb_4bit_use_double_quant=True,
        )
    else:
        kwargs["torch_dtype"] = torch.bfloat16
    model = AutoModelForCausalLM.from_pretrained(
        model_id,
        device_map="cuda",
        attn_implementation="sdpa",
        **kwargs,
    )
    model.eval()
    STATE["model"] = (model, tokenizer)
    STATE["name"] = model_id
    STATE["ready"] = True
    print(f"[server] ready on {torch.cuda.get_device_name(0)}", flush=True)


@app.get("/health")
async def health():
    return {"ok": True, "model": STATE["name"], "ready": STATE["ready"]}


@app.post("/v1/chat/completions")
async def chat(req: ChatRequest):
    if not STATE["ready"]:
        raise HTTPException(status_code=503, detail="model not ready")
    model, tokenizer = STATE["model"]
    messages = [{"role": m.role, "content": m.content} for m in req.messages]
    try:
        # Qwen3 混合思考模型默认输出 <think> 块耗尽 token 预算，评测小模型一律关闭思考模式；
        # 无此模板参数的模型（如 Instruct-2507）自动走 except 分支，行为不变。
        prompt = tokenizer.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=True, enable_thinking=False,
        )
    except Exception:
        prompt = tokenizer.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=True,
        )
    inputs = tokenizer(prompt, return_tensors="pt").to(model.device)
    prompt_tokens = int(inputs["input_ids"].shape[1])
    if prompt_tokens > 20000:
        raise HTTPException(status_code=413, detail=f"prompt too long: {prompt_tokens} tokens")
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
                    pad_token_id=tokenizer.eos_token_id,
                )
            new_tokens = out[0][prompt_tokens:]
            text = tokenizer.decode(new_tokens, skip_special_tokens=True)
            # 双保险：剥离残余 <think> 块（含未闭合前缀），保证下游拿到纯答案。
            if "</think>" in text:
                text = text.split("</think>", 1)[1].strip()
            elif text.lstrip().startswith("<think>"):
                text = ""
            for stop in req.stop or []:
                if stop and stop in text:
                    text = text.split(stop)[0]
            elapsed = time.time() - t0
            print(f"[server] {prompt_tokens}+{len(new_tokens)} tok in {elapsed:.1f}s", flush=True)
            return text, len(new_tokens), elapsed

        try:
            # 硬超时：防止单个异常生成永久占用 STATE["lock"] 堵死整个服务（卡死请求返回 503，锁随 async with 释放）。
            text, completion_tokens, elapsed = await asyncio.wait_for(
                loop.run_in_executor(None, generate), timeout=900
            )
        except asyncio.TimeoutError:
            raise HTTPException(status_code=503, detail="generation timeout (900s); server kept alive")
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=str(exc)) from exc

    return {
        "id": f"local-{time.time_ns()}",
        "object": "chat.completion",
        "model": STATE["name"],
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": text},
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens,
        },
        "timings": {"seconds": round(elapsed, 2)},
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="Qwen/Qwen3-4B-Instruct-2507")
    parser.add_argument("--port", type=int, default=8899)
    parser.add_argument("--dtype", default="4bit", choices=["4bit", "bf16"],
                        help="4bit=bnb 量化（省显存）；bf16=免量化直跑（小模型用）")
    args = parser.parse_args()
    STATE["lock"] = asyncio.Lock()

    def warmup():
        load_model(args.model, quantized=(args.dtype == "4bit"))

    import threading
    threading.Thread(target=warmup, daemon=True).start()

    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    sys.exit(main())
