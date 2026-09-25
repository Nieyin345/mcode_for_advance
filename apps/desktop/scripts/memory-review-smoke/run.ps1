# Headless smoke. Only uses a unique apps/desktop/.tmp directory and cleans it.
$ErrorActionPreference = "Stop"
$desktop = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
Push-Location $desktop
$dir = Join-Path $desktop (".tmp/memory-review-" + [guid]::NewGuid().ToString("N"))
try {
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  $esbuild = Get-ChildItem "../../node_modules/.pnpm" -Directory -Filter "esbuild@*" |
    Sort-Object Name -Descending | Select-Object -First 1
  if ($null -eq $esbuild) { throw "Project esbuild not found (no network npx)." }
  $bin = Join-Path $esbuild.FullName "node_modules/esbuild/bin/esbuild"
  & node $bin scripts/memory-review-smoke/main.ts --bundle --platform=node --format=cjs `
    --tsconfig=tsconfig.json `
    --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts `
    --alias:@main/memory/broadcast.js=./scripts/memory-review-smoke/stubs/broadcast.ts `
    --outfile="$dir/smoke.cjs" --log-level=error
  if ($LASTEXITCODE -ne 0) { throw "esbuild failed ($LASTEXITCODE)" }
  $env:MCODE_SMOKE_DATA_ROOT = Join-Path $dir "data"
  New-Item -ItemType Directory -Path $env:MCODE_SMOKE_DATA_ROOT -Force | Out-Null
  & node "$dir/smoke.cjs"
  if ($LASTEXITCODE -ne 0) { throw "memory-review smoke failed ($LASTEXITCODE)" }
} finally {
  Remove-Item Env:MCODE_SMOKE_DATA_ROOT -ErrorAction SilentlyContinue
  if (Test-Path $dir) { Remove-Item $dir -Recurse -Force }
  Pop-Location
}
