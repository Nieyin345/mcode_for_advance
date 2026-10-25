#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/lib/esbuild-path.sh
OUT="$(mktemp -d "${TMPDIR:-/tmp}/mcode-library-text.XXXXXX")"
trap 'rm -rf "$OUT"' EXIT
"$ESBUILD" scripts/library-unified-text-search-smoke/main.ts --bundle --platform=node --format=esm --tsconfig=tsconfig.json --alias:@main/lib/rgSearch.js=./scripts/library-unified-text-search-smoke/stubs/rgSearch.ts --outfile="$OUT/main.mjs" --log-level=error
node "$OUT/main.mjs"
