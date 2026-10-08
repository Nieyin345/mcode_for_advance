#!/usr/bin/env bash
# custom-tab-race-smoke — CustomTabView 里 FileTab 的旧回包回写(见 main.ts 文件头)。
#
# ⚠️ 关键 alias:
#   - `react` / `react/jsx-runtime` → 极小 hooks 运行时(组件源码原样跑)。
#   - `@renderer/lib/api.js` → **能扣住回包**的替身。
#   - `@renderer/components/chat/Markdown.js` → 直通桩(本套只用非 md 文件)。
#   - store / icons / platform / terminalRunBus → 直通桩(不碰)。
#
# 不起服务、不碰磁盘。
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=$(mktemp -d /tmp/mcode-custom-tab-race.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"
"$ESBUILD" scripts/custom-tab-race-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:react=./scripts/custom-tab-race-smoke/fakeReact.ts \
  --alias:react/jsx-runtime=./scripts/custom-tab-race-smoke/jsxRuntime.ts \
  --alias:@tabler/icons-react=./scripts/custom-tab-race-smoke/iconsStub.cjs \
  --alias:@renderer/lib/api.js=./scripts/custom-tab-race-smoke/api-stub.ts \
  --alias:@renderer/components/chat/Markdown.js=./scripts/custom-tab-race-smoke/markdown-stub.ts \
  --alias:@renderer/stores/customUiStore.js=./scripts/custom-tab-race-smoke/customUiStore-stub.ts \
  --alias:@renderer/stores/toastStore.js=./scripts/custom-tab-race-smoke/toastStore-stub.ts \
  --alias:@renderer/lib/platform.js=./scripts/custom-tab-race-smoke/platform-stub.ts \
  --alias:@renderer/lib/terminalRunBus.js=./scripts/custom-tab-race-smoke/terminalRunBus-stub.ts \
  --alias:@renderer/lib/monacoSetup.js=./scripts/custom-tab-race-smoke/monaco-stub.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
