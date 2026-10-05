#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=$(mktemp -d /tmp/mcode-custom-ui-refresh.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
ESBUILD=$(find ../../node_modules/.pnpm -path '*esbuild/bin/esbuild' -type f | sort -V | tail -1)
"$ESBUILD" scripts/custom-ui-refresh-smoke/main.ts --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
 --banner:js="import {createRequire} from 'node:module';const require=createRequire(import.meta.url);" \
 --alias:@main/window.js=./scripts/custom-ui-refresh-smoke/stubs/window.ts \
 --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
 --alias:@renderer/lib/api.js=./scripts/custom-ui-refresh-smoke/stubs/api.ts \
 --alias:@renderer/stores/sessionStore.js=./scripts/custom-ui-refresh-smoke/stubs/session.ts \
 --alias:@renderer/stores/toastStore.js=./scripts/custom-ui-refresh-smoke/stubs/toast.ts \
 --alias:@renderer/lib/i18n/core.js=./scripts/custom-ui-refresh-smoke/stubs/i18n.ts \
 --external:electron --outfile="$OUT/test.mjs" --log-level=error
node "$OUT/test.mjs"
