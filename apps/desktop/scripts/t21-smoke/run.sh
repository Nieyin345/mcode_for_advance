#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=$(mktemp -d "${TMPDIR:-/tmp}/mcode-t21.XXXXXX")
trap 'rm -rf "$OUT"' EXIT
source scripts/lib/esbuild-path.sh
"$ESBUILD" scripts/t21-smoke/main.tsx \
  --bundle --platform=node --format=esm --jsx=automatic \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
