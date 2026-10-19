#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/lib/esbuild-path.sh
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT
"$ESBUILD" scripts/notification-cache-race-smoke/main.ts --bundle --platform=node --format=esm --tsconfig=tsconfig.json --alias:@contracts/ipc=./scripts/notification-cache-race-smoke/stubContracts.ts --alias:@renderer/lib/api.js=./scripts/notification-cache-race-smoke/stubApi.ts --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
