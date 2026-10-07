#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=$(mktemp -d /tmp/mcode-code-runner-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/code-runner-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
