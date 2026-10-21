#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../../.."  # apps/desktop
OUT=$(mktemp -d /tmp/mcode-t18-composer.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source scripts/lib/esbuild-path.sh

"$ESBUILD" src/renderer/components/chat/tests/t18-behavior.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --alias:react=./scripts/ime-enter-smoke/fakeReact.ts \
  --alias:react/jsx-runtime=./scripts/ime-enter-smoke/jsxRuntime.ts \
  --alias:@renderer/lib/api.js=./src/renderer/components/chat/tests/t18-api-stub.ts \
  --alias:@renderer/lib/i18n/index.js=./src/renderer/components/chat/tests/t18-i18n-stub.ts \
  --alias:@tabler/icons-react=./scripts/ime-enter-smoke/iconsStub.cjs \
  --outfile="$OUT/t18.mjs" --log-level=error

node "$OUT/t18.mjs"
