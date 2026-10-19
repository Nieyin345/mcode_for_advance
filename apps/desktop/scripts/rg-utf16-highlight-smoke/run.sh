#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/lib/esbuild-path.sh
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT
"$ESBUILD" scripts/rg-utf16-highlight-smoke/main.ts --bundle --platform=node --format=esm --tsconfig=tsconfig.json --alias:electron=./scripts/rg-utf16-highlight-smoke/stubElectron.ts --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
