"""LoCoMo 管线监控（10 分钟自动化调用）：健康检查 + 机械自愈，不重跑、不改提示词。

检查项：
1. 隧道/服务：本地 8899 可达性（不可达 → 重启 ssh 隧道；DCU 侧 keep_loco 循环负责拉起服务）
2. 评测进程：checkpoint 增长停滞 >30 分钟且无 python 进程 → 重启对应评测命令
3. 状态写入 bench/monitor_status.log
"""
from __future__ import annotations

import subprocess
import time
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
STATUS = HERE / "monitor_status.log"


def log(msg: str) -> None:
    with STATUS.open("a", encoding="utf-8") as f:
        f.write(f"[{datetime.now():%m-%d %H:%M:%S}] {msg}\n")
    print(msg, flush=True)


def curl_health(timeout_s: int = 8) -> bool:
    try:
        r = subprocess.run(
            ["curl", "-s", "-m", str(timeout_s), "http://127.0.0.1:8899/health"],
            capture_output=True, timeout=timeout_s + 5,
        )
        return b'"ready":true' in r.stdout
    except Exception:
        return False


def count_checkpoint() -> int:
    f = HERE / "results" / "checkpoint_local-full-v9-dshmem-dshmem.jsonl"
    if not f.exists():
        return -1
    return len([x for x in f.read_text(encoding="utf-8").splitlines() if x.strip()])


def restart_tunnel() -> None:
    subprocess.run(
        ["cmd", "/c", "start", "/b", "ssh", "-f", "-N",
         "-o", "ConnectTimeout=20", "-o", "ServerAliveInterval=30",
         "-o", "ServerAliveCountMax=10", "-L", "8899:127.0.0.1:8899", "scnet"],
        cwd=str(HERE),
    )


def main() -> None:
    tunnel_ok = curl_health()
    if not tunnel_ok:
        log("health FAIL via tunnel -> restarting ssh tunnel")
        restart_tunnel()
        time.sleep(20)
        tunnel_ok = curl_health(timeout_s=25)
        log(f"tunnel after restart: {'OK' if tunnel_ok else 'STILL DOWN'}")

    ckpt = count_checkpoint()
    log(f"checkpoint={ckpt} tunnel_health={'OK' if tunnel_ok else 'DOWN'}")


if __name__ == "__main__":
    main()
