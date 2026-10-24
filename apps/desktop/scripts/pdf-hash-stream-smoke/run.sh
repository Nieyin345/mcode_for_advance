#!/usr/bin/env bash
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."
OUT=$(mktemp -d /tmp/mcode-pdf-hash-stream.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$HERE/../lib/esbuild-path.sh"
"$ESBUILD" scripts/pdf-hash-stream-smoke/main.ts --bundle --platform=node --format=esm --tsconfig=tsconfig.json --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" --outfile="$OUT/main.mjs" --log-level=error
node "$OUT/main.mjs"
