#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/lib/esbuild-path.sh
OUT="$(mktemp -d "${TMPDIR:-/tmp}/mcode-ui-convergence.XXXXXX")"
trap 'rm -rf "$OUT"' EXIT
"$ESBUILD" scripts/arc005-ui-convergence-smoke/main.ts --bundle --platform=node --format=esm --tsconfig=tsconfig.json --outfile="$OUT/main.mjs" --log-level=error
node "$OUT/main.mjs"
