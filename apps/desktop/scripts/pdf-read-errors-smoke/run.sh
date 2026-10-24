#!/usr/bin/env bash
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."
OUT=$(mktemp -d /tmp/mcode-pdf-errors.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$HERE/../lib/esbuild-path.sh"
"$ESBUILD" scripts/pdf-read-errors-smoke/main.ts --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
 --alias:pdfjs-dist/legacy/build/pdf.mjs=./scripts/pdf-read-errors-smoke/stubs/pdfjs.ts \
 --alias:node:module=./scripts/pdf-read-errors-smoke/stubs/module.ts \
 --outfile="$OUT/main.mjs" --log-level=error
node "$OUT/main.mjs"
