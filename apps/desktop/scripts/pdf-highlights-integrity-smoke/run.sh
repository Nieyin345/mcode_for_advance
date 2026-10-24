#!/usr/bin/env bash
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."
OUT=$(mktemp -d /tmp/mcode-pdf-highlights.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
# Keep the real, already-installed pdfjs-dist package external to esbuild.
# Its worker/browser branches must be resolved by Node, not bundled.
source scripts/lib/runtime-node-modules.sh
mcode_link_runtime_node_modules "$OUT" "$PWD/node_modules"
source "$HERE/../lib/esbuild-path.sh"
"$ESBUILD" scripts/pdf-highlights-integrity-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --external:pdfjs-dist \
  --alias:@main/store/repositories.js=./scripts/pdf-highlights-integrity-smoke/stubs/repositories.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --outfile="$OUT/main.mjs" --log-level=error
node "$OUT/main.mjs"
