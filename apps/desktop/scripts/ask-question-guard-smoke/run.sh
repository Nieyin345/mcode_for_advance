#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/lib/esbuild-path.sh
OUT=$(mktemp -d "${TMPDIR:-/tmp}/mcode-ask-guard.XXXXXX")
trap 'rm -rf "$OUT"' EXIT
"$ESBUILD" scripts/ask-question-guard-smoke/main.ts --bundle --platform=node --format=esm --tsconfig=tsconfig.json --outfile="$OUT/test.mjs" --log-level=error
node "$OUT/test.mjs"
