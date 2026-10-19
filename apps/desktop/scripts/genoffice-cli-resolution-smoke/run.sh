#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT="$(mktemp -d "${TMPDIR:-/tmp}/mcode-genoffice-cli-resolution.XXXXXX")"
trap 'rm -rf "$OUT"' EXIT
source scripts/lib/esbuild-path.sh
"$ESBUILD" scripts/genoffice-cli-resolution-smoke/main.ts --bundle --platform=node --format=esm --tsconfig=tsconfig.json --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts --outfile="$OUT/main.mjs" --log-level=error
node "$OUT/main.mjs"
