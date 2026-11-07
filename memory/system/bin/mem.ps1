#!/usr/bin/env pwsh
# Convenience wrapper for the memory CLI. The canonical entry is mem.mjs.
$ErrorActionPreference = 'Stop'

$candidates = @()
if ($env:MEM_NODE) { $candidates += $env:MEM_NODE }
$candidates += (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe')
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCommand) { $candidates += $nodeCommand.Source }

$node = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $node) {
  Write-Error '找不到 node；设置 MEM_NODE 或把 node 加入 PATH。'
  exit 1
}

& $node (Join-Path $PSScriptRoot 'mem.mjs') @args
exit $LASTEXITCODE
