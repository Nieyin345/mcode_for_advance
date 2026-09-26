# Windows: real renderer store + library IPC + temporary SQLite, including a restart.
$ErrorActionPreference = 'Stop'
Set-Location (Resolve-Path (Join-Path $PSScriptRoot '../..'))
New-Item -ItemType Directory -Force '.tmp' | Out-Null
$out = Join-Path (Resolve-Path '.tmp') ('library-create-smoke-' + [guid]::NewGuid().ToString('N') + '.mjs')
$banner = "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"
$esbuild = Get-ChildItem '../../node_modules/.pnpm' -Directory -Filter 'esbuild@*' |
  Sort-Object Name -Descending |
  ForEach-Object { Join-Path $_.FullName 'node_modules/esbuild/bin/esbuild' } |
  Where-Object { Test-Path $_ } |
  Select-Object -First 1
if (-not $esbuild) { throw 'Installed esbuild not found; no network install attempted.' }
$code = 1
try {
  & node $esbuild 'scripts/library-create-smoke/main.ts' '--bundle' '--platform=node' '--format=esm' '--tsconfig=tsconfig.json' "--banner:js=$banner" '--external:pdfjs-dist' '--alias:electron=./scripts/library-delete-smoke/stubs/electron.ts' '--alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts' '--alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts' '--alias:@main/window.js=./scripts/library-delete-smoke/stubs/window.ts' '--alias:@main/claude/RuntimeManager.js=./scripts/library-delete-smoke/stubs/runtimeManager.ts' '--alias:@main/browser/BrowserManager.js=./scripts/library-delete-smoke/stubs/browserManager.ts' '--alias:@main/workflows/seed.js=./scripts/library-delete-smoke/stubs/workflowsSeed.ts' '--alias:@renderer/lib/api.js=./scripts/library-create-smoke/stubs/api.ts' "--outfile=$out" '--log-level=error'
  if ($LASTEXITCODE -ne 0) { throw 'Library create smoke bundle failed' }
  & node $out
  $code = $LASTEXITCODE
} finally {
  Remove-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue
}
exit $code
