#!/usr/bin/env bash
# browser-tabs-a11y-smoke — 【UI-013】浏览器标签条的键盘可访问性(a11y)。
#
# 与 ime-enter-smoke 同一套极小 React 运行时(`--alias:react=`),把真 `BrowserTabs`
# 原样跑起来;判据钉在它产出的**元素节点**上(tablist/tab 角色、roving tabindex、
# 方向键真的切换、关闭按钮焦点可见)。不起浏览器、不写盘。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."          # → apps/desktop

OUT=$(mktemp -d /tmp/mcode-browser-tabs-a11y.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$HERE/../lib/esbuild-path.sh"

"$ESBUILD" scripts/browser-tabs-a11y-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:react=./scripts/browser-tabs-a11y-smoke/fakeReact.ts \
  --alias:react/jsx-runtime=./scripts/browser-tabs-a11y-smoke/jsxRuntime.ts \
  --alias:react-dom=./scripts/ime-enter-smoke/reactDomStub.ts \
  --alias:@tabler/icons-react=./scripts/browser-tabs-a11y-smoke/iconsStub.cjs \
  --alias:@renderer/lib/api.js=./scripts/browser-tabs-a11y-smoke/api-stub.ts \
  --external:@renderer/lib/monacoSetup.js \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
