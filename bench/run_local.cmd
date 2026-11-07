@echo off
REM LoCoMo 本地评测一键脚本：起本地推理服务 -> 等就绪 -> 跑评测
REM 用法：bench\run_local.cmd dev          （dev 子集，2 对话）
REM       bench\run_local.cmd full         （全量 10 对话）
REM       bench\run_local.cmd full-v7 xyz  （自定义 tag）

setlocal
set HF_HOME=D:\hf-cache
set TAG=%1
if "%TAG%"=="" set TAG=dev
set EXTRA=%2

cd /d "%~dp0"

echo [run] 启动本地推理服务（Qwen3-4B-Instruct-2507, 4bit）...
start "loco-local-llm" /min python local_server.py --model Qwen/Qwen3-4B-Instruct-2507 --port 8899

set /a TRIES=0
:waitloop
timeout /t 10 /nobreak >nul
set /a TRIES+=1
curl -s -o nul -w "%%{http_code}" http://127.0.0.1:8899/health | findstr "200" >nul
if errorlevel 1 (
  if %TRIES% lss 60 (
    echo [run] 模型加载中... (%TRIES%/60)
    goto waitloop
  )
  echo [run] 服务 10 分钟未就绪，退出。
  exit /b 1
)
echo [run] 服务就绪。

if "%TAG%"=="dev" (
  python locomo_eval.py --systems dshmem,full --limit-dialogs 2 --per-cat 6 --tag dev-%EXTRA%
) else (
  python locomo_eval.py --systems dshmem,full --per-cat 6 --k 4 --no-ingest --tag %TAG%-%EXTRA%
)
echo [run] 完成。
endlocal
