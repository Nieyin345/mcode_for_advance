#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=$(mktemp -d /tmp/mcode-mcp-market-boundary.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source scripts/lib/esbuild-path.sh
"$ESBUILD" scripts/mcp-market-boundary-smoke/main.ts --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/store/repositories.js=./scripts/market-smoke/stubs/repositories.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error
mkdir -p "$OUT/home"
HOME="$OUT/home" USERPROFILE="$OUT/home" node "$OUT/smoke.mjs"
