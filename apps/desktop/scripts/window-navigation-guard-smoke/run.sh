#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=$(mktemp -d /tmp/mcode-window-navigation.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source scripts/lib/esbuild-path.sh
"$ESBUILD" scripts/window-navigation-guard-smoke/main.ts \
  --bundle --platform=node --format=esm --target=es2022 \
  --tsconfig=tsconfig.json --outfile="$OUT/test.mjs" --log-level=error
node "$OUT/test.mjs"
