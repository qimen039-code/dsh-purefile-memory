@echo off
REM Monitor GPU-training PID; exit 0 when the process is gone (GPU free).
REM Uses ping for sleeping: `timeout` requires a real console stdin and fails in pipes.
setlocal
set WAITPID=%1
if "%WAITPID%"=="" set WAITPID=29304

:check
ping -n 181 127.0.0.1 >nul
tasklist /fi "PID eq %WAITPID%" 2>nul | find "%WAITPID%" >nul
if errorlevel 1 (
  echo [%date% %time%] TRAINING-FINISHED-OR-EXITED pid=%WAITPID%
  exit /b 0
)
echo [%date% %time%] training still running pid=%WAITPID%
goto check
