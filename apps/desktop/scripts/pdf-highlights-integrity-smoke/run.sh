#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=$(mktemp -d /tmp/mcode-pdf-highlights.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
# Keep the real, already-installed pdfjs-dist package external to esbuild.
# Its worker/browser branches must be resolved by Node, not bundled.
ln -s "$PWD/node_modules" "$OUT/node_modules"
source "$(dirname "$0")/../lib/esbuild-path.sh"
"$ESBUILD" scripts/pdf-highlights-integrity-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --external:pdfjs-dist \
  --outfile="$OUT/main.mjs" --log-level=error
node "$OUT/main.mjs"
