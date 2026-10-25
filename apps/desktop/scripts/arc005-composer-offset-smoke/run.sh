#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/lib/esbuild-path.sh
OUT="$(mktemp -d "${TMPDIR:-/tmp}/mcode-composer-offset.XXXXXX")"
trap 'rm -rf "$OUT"' EXIT
"$ESBUILD" scripts/arc005-composer-offset-smoke/main.ts --bundle --platform=node --format=esm --tsconfig=tsconfig.json --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
