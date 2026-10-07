#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p .tmp
OUT=$(mktemp -d "${PWD}/.tmp/event-vertical-smoke.XXXXXX")
trap 'rm -rf "$OUT"' EXIT
export MCODE_SMOKE_DATA_ROOT="$OUT/data"
export TMPDIR="$OUT"
mkdir -p "$MCODE_SMOKE_DATA_ROOT" "$OUT/stubs"
source "$(dirname "$0")/../lib/esbuild-path.sh"
if [[ -z "$ESBUILD" ]]; then echo 'Installed esbuild not found; no network install attempted.' >&2; exit 1; fi
node "$ESBUILD" scripts/automation-smoke/stubs/runner.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --outfile="$OUT/stubs/runner.js" --log-level=error
printf 'export * from "./stubs/runner.js";\n' > "$OUT/runner.js"
node "$ESBUILD" scripts/event-vertical-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --external:./runner.js --external:./stubs/runner.js \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:@main/claude/RuntimeManager.js=./scripts/automation-smoke/stubs/runtimeManager.ts \
  --alias:@main/plugins/pluginManager.js=./scripts/mcode-admin-smoke/stubs/pluginManager.ts \
  --outfile="$OUT/main.mjs" --log-level=error
node "$OUT/main.mjs"
