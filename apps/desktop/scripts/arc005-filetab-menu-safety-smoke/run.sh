#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE/../.."
source "$HERE/../lib/esbuild-path.sh"
OUT="$(mktemp -d "${TMPDIR:-/tmp}/mcode-file-menu.XXXXXX")"
trap 'rm -rf "$OUT"' EXIT
"$ESBUILD" scripts/arc005-filetab-menu-safety-smoke/main.ts --bundle --platform=node --format=esm --tsconfig=tsconfig.json --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
