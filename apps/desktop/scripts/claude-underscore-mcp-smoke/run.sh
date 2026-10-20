#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/lib/esbuild-path.sh
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT
"$ESBUILD" scripts/claude-underscore-mcp-smoke/main.ts --bundle --platform=node --format=esm --tsconfig=tsconfig.json --alias:@main/orchestration/effectiveToolInventory.js=./scripts/claude-underscore-mcp-smoke/stubInventory.ts --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
