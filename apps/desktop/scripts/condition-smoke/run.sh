#!/usr/bin/env bash
# No Electron or live DB. Real catalog + scheduler + validator with injected ports.
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p .tmp
OUT=$(mktemp -d "${PWD}/.tmp/mcode-condition-smoke.XXXXXX")
trap 'rm -rf "$OUT"' EXIT
export TMPDIR="$OUT"
source "$(dirname "$0")/../lib/esbuild-path.sh"
if [[ -z "$ESBUILD" ]]; then echo 'Installed esbuild not found; no network install attempted.' >&2; exit 1; fi
node "$ESBUILD" scripts/condition-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
