# edge_cdp.ps1 — 启动/检测带调试端口的 Edge（专用 profile，不影响日常浏览器）。
# 用法:  pwsh scripts/edge_cdp.ps1 [-Port 9222]
# 启动后在该 Edge 窗口完成机构登录（含 MFA），随后 scholar 即可复用该登录态下载付费墙 PDF。
param(
  [int]$Port = 9222,
  [string]$ProfileDir = ""
)
$ErrorActionPreference = "Stop"
# 端口已被占用（已有调试浏览器）则直接提示复用，不重复启动
try {
  $v = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 3
  Write-Output "CDP 端口 $Port 已有调试浏览器: $($v.Browser)"
  Write-Output "直接复用现有登录态运行: node scripts/cdp_download.mjs --url <pdf-url> --out <file.pdf> --port $Port"
  exit 0
} catch { }
$edge = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $edge) { Write-Error "未找到 Microsoft Edge"; exit 1 }
if (-not $ProfileDir) { $ProfileDir = Join-Path $env:LOCALAPPDATA "scholar_edge_cdp" }
New-Item -ItemType Directory -Path $ProfileDir -Force | Out-Null
Start-Process -FilePath $edge -ArgumentList @(
  "--remote-debugging-port=$Port",
  "--user-data-dir=$ProfileDir",
  "--no-first-run",
  "--no-default-browser-check"
)
Start-Sleep -Seconds 4
try {
  $v = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 5
  Write-Output "Edge CDP 已启动: http://127.0.0.1:$Port (profile: $ProfileDir) | $($v.Browser)"
  Write-Output "请在该 Edge 窗口完成机构登录（如 Publisher -> Access through your institution），然后运行:"
  Write-Output "  node scripts/cdp_download.mjs --url <pdf-url> --out <file.pdf> --port $Port"
} catch {
  Write-Output "Edge 已启动但 CDP 未就绪，请稍等或检查端口是否被占用"; exit 1
}