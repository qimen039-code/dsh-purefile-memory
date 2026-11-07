# =====================================================================
# DSH Memory System - one-shot environment check & install (Windows)
# 用法:
#   pwsh -File scripts\install.ps1 -RepoRoot <仓库根>
#   可选开关: -WithServer      额外安装本地模型服务依赖(GPU 栈)
#             -DownloadModel   下载 Qwen3-4B-Instruct-2507 权重(约 8GB)
#             -ModelDir <dir>  权重目标目录(默认 <RepoRoot>\models)
# 说明: 本脚本只调用 winget/pip/huggingface-cli 官方工具, 自身不直接发起 HTTP;
#       模型下载源固定为 https://huggingface.co (若不可达请自行配置镜像后手动下载).
# =====================================================================
param(
    [string]$RepoRoot = "",
    [switch]$WithServer,
    [switch]$DownloadModel,
    [string]$ModelDir = ""
)
$ErrorActionPreference = "Stop"

if (-not $RepoRoot) { $RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path) }
$RepoRoot = (Resolve-Path $RepoRoot).Path
Write-Host "=== DSH Memory System 环境安装 ===" -ForegroundColor Cyan
Write-Host "仓库根: $RepoRoot"

function Test-Cmd($name) {
    return $null -ne (Get-Command $name -ErrorAction SilentlyContinue)
}
function Get-Ver($name, $arg) {
    try { return (& $name $arg 2>$null).ToString().Trim() } catch { return "unknown" }
}

# ---------- 1. 基础工具检查 ----------
$missing = @()
if (Test-Cmd git)    { Write-Host ("[OK] git    " + (Get-Ver git "--version")) } else { $missing += "git" }
if (Test-Cmd python) { Write-Host ("[OK] python " + (Get-Ver python "--version")) } else { $missing += "python" }
if (Test-Cmd node)   { Write-Host ("[OK] node   " + (Get-Ver node "--version")) }   else { $missing += "node" }

if ($missing.Count -gt 0) {
    Write-Host ("[MISSING] " + ($missing -join ", ")) -ForegroundColor Yellow
    if (Test-Cmd winget) {
        foreach ($m in $missing) {
            $pkg = @{ "git" = "Git.Git"; "python" = "Python.Python.3.12"; "node" = "OpenJS.NodeJS.LTS" }[$m]
            Write-Host ("winget install " + $pkg + " ...")
            winget install --id $pkg -e --accept-source-agreements --accept-package-agreements
        }
        Write-Host "安装后请重开终端使 PATH 生效, 再运行本脚本." -ForegroundColor Yellow
        exit 1
    } else {
        Write-Host "未检测到 winget, 请手动安装缺失工具后重试." -ForegroundColor Red
        exit 1
    }
}

# ---------- 2. Python 依赖 ----------
Write-Host "`n--- 安装 Python 依赖 ---" -ForegroundColor Cyan
python -m pip install --upgrade pip -q
python -m pip install -r (Join-Path $RepoRoot "requirements.txt") -q
if ($WithServer) {
    python -m pip install -r (Join-Path $RepoRoot "requirements-server.txt") -q
    Write-Host "[OK] 服务端依赖(torch 栈)已安装"
}

# ---------- 3. 生成记忆系统配置 ----------
$cfgDir  = Join-Path $RepoRoot "memory\system"
$cfgEx   = Join-Path $cfgDir "config.example.json"
$cfgLive = Join-Path $cfgDir "config.json"
if (Test-Path $cfgLive) {
    Write-Host "[SKIP] memory/system/config.json 已存在(不覆盖)"
} else {
    $json = Get-Content $cfgEx -Raw -Encoding UTF8 | ConvertFrom-Json
    $json.defaultWorkspace = $RepoRoot
    $json | ConvertTo-Json -Depth 10 | Out-File $cfgLive -Encoding UTF8
    Write-Host "[OK] 已生成 config.json (defaultWorkspace = $RepoRoot)"
}

# ---------- 4. 自检 ----------
Write-Host "`n--- 自检 ---" -ForegroundColor Cyan
$memCmd = Join-Path $RepoRoot "memory\system\bin\mem.cmd"
if (Test-Path $memCmd) {
    & $memCmd doctor
    if ($LASTEXITCODE -ne 0) { Write-Host "[FAIL] mem doctor 未通过" -ForegroundColor Red; exit 1 }
    & $memCmd selftest
    if ($LASTEXITCODE -ne 0) { Write-Host "[FAIL] mem selftest 未通过" -ForegroundColor Red; exit 1 }
} else {
    node (Join-Path $RepoRoot "memory\system\bin\mem.mjs") doctor
    node (Join-Path $RepoRoot "memory\system\bin\mem.mjs") selftest
}

# ---------- 5. 可选: 模型下载 ----------
if ($DownloadModel) {
    Write-Host "`n--- 下载模型 (源: https://huggingface.co) ---" -ForegroundColor Cyan
    if (-not $ModelDir) { $ModelDir = Join-Path $RepoRoot "models" }
    python -m pip install -q "huggingface_hub[cli]"
    python -m huggingface_hub.commands.huggingface_cli download Qwen/Qwen3-4B-Instruct-2507 --local-dir $ModelDir
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[FAIL] 模型下载失败(检查网络或配置 HF_ENDPOINT 镜像后重试)" -ForegroundColor Red
        exit 1
    }
    Write-Host ("[OK] 模型已就位: " + $ModelDir)
}

# ---------- 6. 完成摘要 ----------
Write-Host "`n=== 完成 ===" -ForegroundColor Green
Write-Host "下一步:"
Write-Host "  1) 自检: $memCmd doctor / selftest"
Write-Host "  2) 本地模型服务(可选): python bench\local_server.py --model <模型路径> --port 8899"
Write-Host "  3) 评测: python bench\locomo_eval.py --systems dshmem --per-cat 6 --k 4 --tag my-run"
if ($DownloadModel) {
    Write-Host ("     模型路径: " + $ModelDir)
}
