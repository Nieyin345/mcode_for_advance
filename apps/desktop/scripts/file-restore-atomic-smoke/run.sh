#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/lib/esbuild-path.sh
OUT=$(mktemp -d "${TMPDIR:-/tmp}/mcode-restore-atomic.XXXXXX")
trap 'rm -rf "$OUT"' EXIT
"$ESBUILD" scripts/file-restore-atomic-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --alias:@main/lib/atomicFile.js=./scripts/file-restore-atomic-smoke/stubs/atomicFile.ts \
  --outfile="$OUT/test.mjs" --log-level=error
node "$OUT/test.mjs"
