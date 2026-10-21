#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=$(mktemp -d /tmp/mcode-file-picker-error.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "scripts/lib/esbuild-path.sh"
mcode_esbuild scripts/arc005-file-picker-error-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
