#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=$(mktemp -d /tmp/mcode-pdf-index-ui.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"
"$ESBUILD" scripts/pdf-preview-index-notice-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --define:import.meta.env.BASE_URL='"./"' \
  --alias:react=./scripts/preview-panel-smoke/fakeReact.ts \
  --alias:react/jsx-runtime=./scripts/maint-m35-smoke/stubs/reactEffects/jsx-runtime.ts \
  --alias:@renderer/lib/api.js=./scripts/pdf-preview-index-notice-smoke/deps.ts \
  --alias:@renderer/lib/i18n/index.js=./scripts/pdf-preview-index-notice-smoke/deps.ts \
  --alias:@renderer/stores/toastStore.js=./scripts/pdf-preview-index-notice-smoke/deps.ts \
  --alias:@renderer/stores/fileViewStore.js=./scripts/pdf-preview-index-notice-smoke/deps.ts \
  --alias:@renderer/lib/cn.js=./scripts/pdf-preview-index-notice-smoke/deps.ts \
  --alias:@renderer/lib/icons.js=./scripts/pdf-preview-index-notice-smoke/deps.ts \
  --alias:@embedpdf/react-pdf-viewer=./scripts/pdf-preview-index-notice-smoke/deps.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
