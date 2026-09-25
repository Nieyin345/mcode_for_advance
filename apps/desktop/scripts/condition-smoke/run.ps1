# Native Windows runner for the condition smoke (no WSL/Git Bash required).
$ErrorActionPreference = 'Stop'
Set-Location (Resolve-Path (Join-Path $PSScriptRoot '../..'))
New-Item -ItemType Directory -Force '.tmp' | Out-Null
$out = Join-Path (Resolve-Path '.tmp') ('condition-smoke-' + [guid]::NewGuid().ToString('N') + '.mjs')
$banner = "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"
$esbuild = Get-ChildItem '../../node_modules/.pnpm' -Directory -Filter 'esbuild@*' |
  Sort-Object Name -Descending |
  ForEach-Object { Join-Path $_.FullName 'node_modules/esbuild/bin/esbuild' } |
  Where-Object { Test-Path $_ } |
  Select-Object -First 1
if (-not $esbuild) { throw 'Installed esbuild not found; no network install attempted.' }
$code = 1
try {
  & node $esbuild 'scripts/condition-smoke/main.ts' '--bundle' '--platform=node' '--format=esm' '--tsconfig=tsconfig.json' "--banner:js=$banner" '--alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts' '--alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts' "--outfile=$out" '--log-level=error'
  if ($LASTEXITCODE -ne 0) { throw 'Condition smoke bundle failed' }
  & node $out
  $code = $LASTEXITCODE
} finally {
  Remove-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue
}
exit $code
