#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=$(mktemp -d /tmp/mcode-t20-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source scripts/lib/esbuild-path.sh
"$ESBUILD" scripts/t20-sandbox-mic-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
