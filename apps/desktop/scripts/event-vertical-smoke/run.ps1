# Native Windows / isolated store. All temporary paths remain under mcode.
# -Suite automation-smoke also runs the pre-existing automation regression suite.
param([ValidateSet('event-vertical-smoke', 'automation-smoke')][string]$Suite = 'event-vertical-smoke')
$ErrorActionPreference = 'Stop'
Set-Location (Resolve-Path (Join-Path $PSScriptRoot '../..'))
New-Item -ItemType Directory -Force '.tmp' | Out-Null
$out = Join-Path (Resolve-Path '.tmp') ($Suite + '-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force (Join-Path $out 'stubs'), (Join-Path $out 'data') | Out-Null
$env:MCODE_SMOKE_DATA_ROOT = Join-Path $out 'data'
$env:TEMP = $out
$env:TMP = $out
$esbuild = Get-ChildItem '../../node_modules/.pnpm' -Directory -Filter 'esbuild@*' |
  Sort-Object Name -Descending |
  ForEach-Object { Join-Path $_.FullName 'node_modules/esbuild/bin/esbuild' } |
  Where-Object { Test-Path $_ } | Select-Object -First 1
$code = 1
try {
  if (-not $esbuild) { throw 'Installed esbuild not found; no network install attempted.' }
  & node $esbuild 'scripts/automation-smoke/stubs/runner.ts' '--bundle' '--platform=node' '--format=esm' '--tsconfig=tsconfig.json' "--outfile=$out/stubs/runner.js" '--log-level=error'
  if ($LASTEXITCODE -ne 0) { throw 'Runner stub bundle failed' }
  Set-Content -LiteralPath (Join-Path $out 'runner.js') -Value 'export * from "./stubs/runner.js";' -Encoding UTF8
  $banner = "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"
  & node $esbuild "scripts/$Suite/main.ts" '--bundle' '--platform=node' '--format=esm' '--tsconfig=tsconfig.json' "--banner:js=$banner" '--external:./runner.js' '--external:./stubs/runner.js' '--alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts' '--alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts' '--alias:@main/claude/RuntimeManager.js=./scripts/automation-smoke/stubs/runtimeManager.ts' '--alias:@main/plugins/pluginManager.js=./scripts/mcode-admin-smoke/stubs/pluginManager.ts' "--outfile=$out/main.mjs" '--log-level=error'
  if ($LASTEXITCODE -ne 0) { throw 'Smoke bundle failed' }
  & node (Join-Path $out 'main.mjs')
  $code = $LASTEXITCODE
} finally {
  Remove-Item -LiteralPath $out -Force -Recurse -ErrorAction SilentlyContinue
}
exit $code
