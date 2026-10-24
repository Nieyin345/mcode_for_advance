#!/usr/bin/env bash
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."
OUT=$(mktemp -d /tmp/mcode-node-input-boundary.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$HERE/../lib/esbuild-path.sh"
"$ESBUILD" scripts/node-input-boundary-smoke/main.ts --bundle --platform=node --format=esm --tsconfig=tsconfig.json --external:ssh2 --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
