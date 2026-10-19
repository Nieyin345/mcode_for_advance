#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/lib/esbuild-path.sh
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT
"$ESBUILD" scripts/criteria-key-integrity-smoke/main.ts --bundle --platform=node --format=esm --tsconfig=tsconfig.json --alias:@main/store/repositories.js=./scripts/criteria-key-integrity-smoke/stubRepositories.ts --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
