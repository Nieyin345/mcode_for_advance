#!/usr/bin/env bash
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."
OUT=$(mktemp -d ./.tmp/file-restore-race.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$HERE/../lib/esbuild-path.sh"
"$ESBUILD" scripts/file-restore-race-smoke/main.ts \
 --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
 --alias:node:fs/promises=./scripts/file-restore-race-smoke/fsPromisesStub.ts \
 --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
