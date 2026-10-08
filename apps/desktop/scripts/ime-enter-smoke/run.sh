#!/usr/bin/env bash
# ime-enter-smoke — 非 IDE 组件里文本输入框上的 Enter 缺 IME 守卫(见 main.ts 文件头)。
#
# ⚠️ 关键 alias:
#   - `react` / `react/jsx-runtime` → ide-ime-smoke 那套极小 hooks 运行时(组件源码原样跑)。
#   - `@renderer/lib/api.js` → 记事 Proxy 桩(判据是"那个动作有没有被触发")。
#   - `@renderer/components/ui/{index,input,button}.js` → 桩:Input 渲染成**真实的 input 节点**,
#     其余直通(判据挂在输入框的 onKeyDown 上,直通的话它不在树里)。
#   - `react-dom` → createPortal 直通(SelectionQuoteMenu 的浮层)。
#   - `@tabler/icons-react` → 空壳 barrel。
#
# 不起服务、不碰磁盘。
set -euo pipefail
cd "$(dirname "$0")/../.."          # → apps/desktop

OUT=$(mktemp -d /tmp/mcode-ime-enter.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/ime-enter-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:react=./scripts/ime-enter-smoke/fakeReact.ts \
  --alias:react/jsx-runtime=./scripts/ime-enter-smoke/jsxRuntime.ts \
  --alias:react-dom=./scripts/ime-enter-smoke/reactDomStub.ts \
  --alias:@tabler/icons-react=./scripts/ime-enter-smoke/iconsStub.cjs \
  --alias:@renderer/lib/api.js=./scripts/ime-enter-smoke/api-stub.ts \
  --alias:@renderer/components/ui/index.js=./scripts/ime-enter-smoke/ui-stub.ts \
  --alias:@renderer/components/ui/input.js=./scripts/ime-enter-smoke/ui-stub.ts \
  --alias:@renderer/components/ui/button.js=./scripts/ime-enter-smoke/ui-stub.ts \
  --external:@renderer/lib/monacoSetup.js \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
