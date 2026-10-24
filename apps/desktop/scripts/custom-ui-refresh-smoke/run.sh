#!/usr/bin/env bash
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."
OUT=$(mktemp -d /tmp/mcode-custom-ui-refresh.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$HERE/../lib/esbuild-path.sh"
"$ESBUILD" scripts/custom-ui-refresh-smoke/main.ts --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
 --banner:js="import {createRequire} from 'node:module';const require=createRequire(import.meta.url);" \
 --alias:@main/window.js=./scripts/custom-ui-refresh-smoke/stubs/window.ts \
 --alias:@main/claude/RuntimeManager.js=./scripts/app-control-smoke/stubs/runtimeManager.ts \
 --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
 --alias:@renderer/lib/api.js=./scripts/custom-ui-refresh-smoke/stubs/api.ts \
 --alias:@renderer/stores/sessionStore.js=./scripts/custom-ui-refresh-smoke/stubs/session.ts \
 --alias:@renderer/stores/toastStore.js=./scripts/custom-ui-refresh-smoke/stubs/toast.ts \
 --alias:@renderer/lib/i18n/core.js=./scripts/custom-ui-refresh-smoke/stubs/i18n.ts \
 --alias:electron=./scripts/library-delete-smoke/stubs/electron.ts \
 --alias:@main/document/genofficeNativeVendor.js=./src/main/document/genofficeNativeVendorStub.ts \
 --outfile="$OUT/test.mjs" --log-level=error
node "$OUT/test.mjs"
