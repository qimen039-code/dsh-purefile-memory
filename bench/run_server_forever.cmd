@echo off
REM Local inference server supervisor v5 (ASCII only; ping-based sleep: `timeout` fails on redirected stdin).
REM - health watchdog: no response -> kill port holder -> restart
REM - periodic restart every ~2h to recycle VRAM/KV fragmentation

set HF_HOME=D:\hf-cache
set HF_HUB_OFFLINE=1
cd /d "%~dp0"

:loop
echo [%date% %time%] [supervisor] starting server >> server.log
start "" /b python local_server.py --model D:\hf-cache\hub\models--Qwen--Qwen3-4B-Instruct-2507\snapshots\cdbee75f17c01a7cc42f958dc650907174af0554 --port 8899 >> server.log 2>&1
echo [%date% %time%] [supervisor] waiting for load >> server.log
ping -n 71 127.0.0.1 >nul

set /a TICKS=0
:watch
ping -n 21 127.0.0.1 >nul
set /a TICKS+=1
curl -s -m 6 http://127.0.0.1:8899/health >nul 2>&1
if errorlevel 1 (
  echo [%date% %time%] [supervisor] health FAILED, killing port-8899 holder >> server.log
  for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8899" ^| findstr "LISTENING"') do taskkill /f /pid %%p >> server.log 2>&1
  ping -n 9 127.0.0.1 >nul
  goto loop
)
if %TICKS% geq 360 (
  echo [%date% %time%] [supervisor] periodic restart to recycle VRAM >> server.log
  for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8899" ^| findstr "LISTENING"') do taskkill /f /pid %%p >> server.log 2>&1
  ping -n 9 127.0.0.1 >nul
  goto loop
)
goto watch
