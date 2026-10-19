#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/lib/esbuild-path.sh
OUT=$(mktemp -d /tmp/mcode-output-buffer-integrity-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
"$ESBUILD" scripts/output-buffer-integrity-smoke/main.ts --bundle --platform=node --format=esm --tsconfig=tsconfig.json --outfile="$OUT/main.mjs" --log-level=error
node "$OUT/main.mjs"
