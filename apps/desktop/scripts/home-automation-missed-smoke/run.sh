#!/usr/bin/env bash
# home-automation-missed-smoke — 首屏把「错过定时」的自动化画成一切正常(见 main.ts 文件头)。
#
# ⚠️ 关键 alias:
#   - `react` / `react/jsx-runtime` → 极小 hooks 运行时(组件源码原样跑)。
#   - `@renderer/lib/api.js`       → 本目录替身(事实表由测试现灌)。
#   - `@tabler/icons-react` / `@renderer/lib/icons.js` → 空壳 barrel(图标是惰性 JSX)。
# 不起服务、不碰磁盘、不连 IPC。
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=$(mktemp -d /tmp/mcode-home-automation-missed.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"
"$ESBUILD" scripts/home-automation-missed-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:react=./scripts/home-automation-missed-smoke/fakeReact.ts \
  --alias:react/jsx-runtime=./scripts/home-automation-missed-smoke/jsxRuntime.ts \
  --alias:@tabler/icons-react=./scripts/home-automation-missed-smoke/iconsStub.cjs \
  --alias:@renderer/lib/icons.js=./scripts/home-automation-missed-smoke/iconsStub.cjs \
  --alias:@renderer/lib/api.js=./scripts/home-automation-missed-smoke/api-stub.ts \
  --alias:@renderer/lib/monacoSetup.js=./scripts/home-automation-missed-smoke/monaco-stub.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
