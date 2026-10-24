#!/usr/bin/env bash
# clickable-row-a11y-smoke — 【MC-049】可点击行的键盘激活(组件行为 + 真调用点 +
# 全渲染端静态规则)。
#
# 与 browser-tabs-a11y-smoke 同一套极小 React 运行时(`--alias:react=`),真
# `ClickableRow` 与真 `BrowserToolbar` 原样跑在上面;静态层用 TypeScript AST 扫
# `src/renderer/**/*.tsx`。不起浏览器、不写盘。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."          # → apps/desktop

OUT=$(mktemp -d /tmp/mcode-clickable-row-a11y.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$HERE/../lib/esbuild-path.sh"

"$ESBUILD" scripts/clickable-row-a11y-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:react=./scripts/clickable-row-a11y-smoke/fakeReact.ts \
  --alias:react/jsx-runtime=./scripts/clickable-row-a11y-smoke/jsxRuntime.ts \
  --alias:react-dom=./scripts/ime-enter-smoke/reactDomStub.ts \
  --alias:@tabler/icons-react=./scripts/clickable-row-a11y-smoke/iconsStub.cjs \
  --alias:@renderer/lib/api.js=./scripts/clickable-row-a11y-smoke/api-stub.ts \
  --external:typescript \
  --external:@renderer/lib/monacoSetup.js \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
