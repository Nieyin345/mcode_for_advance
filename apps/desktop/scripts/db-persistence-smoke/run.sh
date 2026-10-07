#!/usr/bin/env bash
# Isolated persistence failure injection. Never points at the real data root.
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=$(mktemp -d /tmp/mcode-db-persistence-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"
if [[ -z "$ESBUILD" ]]; then
  echo "esbuild is missing; install workspace dependencies before running smoke tests" >&2
  exit 1
fi
"$ESBUILD" scripts/db-persistence-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:node:fs=./scripts/db-persistence-smoke/stubs/fs.ts \
  --alias:@main/lib/dataRoot.js=./scripts/db-migrate-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/db-migrate-smoke/stubs/logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
node scripts/db-persistence-smoke/run-callers.cjs
