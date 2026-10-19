#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/lib/esbuild-path.sh
OUT=$(mktemp -d "${TMPDIR:-/tmp}/mcode-python-identity.XXXXXX")
trap 'rm -rf "$OUT"' EXIT
"$ESBUILD" scripts/python-interpreter-identity-smoke/main.ts --bundle --platform=node --format=esm --tsconfig=tsconfig.json --outfile="$OUT/check.mjs" --log-level=error
node "$OUT/check.mjs"
