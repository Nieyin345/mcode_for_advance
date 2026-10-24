#!/usr/bin/env bash
# T42 isolated managed-node-pack + Host IPC + mutation checks.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."
OUT=$(mktemp -d "${TMPDIR:-/tmp}/mcode-t42-test.XXXXXX")
trap 'rm -rf "$OUT"' EXIT
source "$HERE/../lib/esbuild-path.sh"
"$ESBUILD" scripts/t42-node-pack-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --outfile="$OUT/main.mjs" --log-level=error
node "$OUT/main.mjs"
