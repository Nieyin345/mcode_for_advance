#!/usr/bin/env bash
set -euo pipefail
# HERE 在 cd 之前算好：cd 之后 $0 仍是调用者给的相对路径。
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."
source "$HERE/../lib/esbuild-path.sh"
OUT="$(mktemp -d "${TMPDIR:-/tmp}/mcode-workbook-sheets.XXXXXX")"
trap 'rm -rf "$OUT"' EXIT
"$ESBUILD" scripts/workbook-sheets-smoke/main.ts --bundle --platform=node --format=esm --tsconfig=tsconfig.json --outfile="$OUT/main.mjs" --log-level=error
node "$OUT/main.mjs"
