#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=$(mktemp -d ./.tmp/file-restore-race.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"
"$ESBUILD" scripts/file-restore-race-smoke/main.ts \
 --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
 --alias:node:fs/promises=./scripts/file-restore-race-smoke/fsPromisesStub.ts \
 --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
