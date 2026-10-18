#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=$(mktemp -d /tmp/mcode-executor-ownership.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source scripts/lib/esbuild-path.sh
if [[ -z "${ESBUILD:-}" ]]; then echo "esbuild unavailable" >&2; exit 1; fi
"$ESBUILD" scripts/executor-ownership-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
