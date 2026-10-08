#!/usr/bin/env bash
# ide-ime-smoke — IDE 文本输入框上的 Enter 缺 IME 守卫(见 main.ts 文件头)。
#
# ⚠️ 关键 alias:
#   - `react` / `react/jsx-runtime` → maint-m32-smoke 那套极小 hooks 运行时(组件源码原样跑)。
#   - `@renderer/lib/api.js` → 记事 Proxy 桩(判据是"那个动作有没有被触发")。
#   - `@base-ui/react/*` 与 `@renderer/components/ui/index.js` → 直通桩(不被调用,只要
#     能解析、且把 children 物化进树)。
#   - `@tabler/icons-react` → 空壳 barrel。
#
# 不起服务、不碰磁盘。
set -euo pipefail
cd "$(dirname "$0")/../.."          # → apps/desktop

OUT=$(mktemp -d /tmp/mcode-ide-ime.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/ide-ime-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:react=./scripts/ide-ime-smoke/fakeReact.ts \
  --alias:react/jsx-runtime=./scripts/ide-ime-smoke/jsxRuntime.ts \
  --alias:@tabler/icons-react=./scripts/ide-ime-smoke/iconsStub.cjs \
  --alias:@renderer/lib/api.js=./scripts/ide-ime-smoke/api-stub.ts \
  --alias:@renderer/components/ui/index.js=./scripts/ide-ime-smoke/ui-stub.ts \
  --alias:@base-ui/react/menu=./scripts/ide-ime-smoke/menu-stub.ts \
  --alias:@base-ui/react/context-menu=./scripts/ide-ime-smoke/menu-stub.ts \
  --external:@renderer/lib/monacoSetup.js \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
