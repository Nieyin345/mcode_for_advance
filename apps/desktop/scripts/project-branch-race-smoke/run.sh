#!/usr/bin/env bash
# project-branch-race-smoke — ProjectBranchIndicator 的旧回包回写(见 main.ts 文件头)。
#
# ⚠️ 关键 alias:
#   - `react` / `react/jsx-runtime` → 极小 hooks 运行时(组件源码原样跑)。
#   - `@renderer/lib/api.js` → **能扣住回包**的替身(弱网下旧回包后到)。
#   - `@base-ui/react/*` / ui → 直通桩(不被调用,只要能把 children 物化进树)。
#   - `@tabler/icons-react` → 空壳 barrel。
#
# 不起服务、不碰磁盘。
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=$(mktemp -d /tmp/mcode-project-branch-race.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"
"$ESBUILD" scripts/project-branch-race-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:react=./scripts/project-branch-race-smoke/fakeReact.ts \
  --alias:react/jsx-runtime=./scripts/project-branch-race-smoke/jsxRuntime.ts \
  --alias:@tabler/icons-react=./scripts/project-branch-race-smoke/iconsStub.cjs \
  --alias:@renderer/lib/api.js=./scripts/project-branch-race-smoke/api-stub.ts \
  --alias:@renderer/components/ui/index.js=./scripts/project-branch-race-smoke/ui-stub.ts \
  --alias:@base-ui/react/menu=./scripts/project-branch-race-smoke/menu-stub.ts \
  --alias:@base-ui/react/context-menu=./scripts/project-branch-race-smoke/menu-stub.ts \
  --alias:@renderer/lib/monacoSetup.js=./scripts/project-branch-race-smoke/monaco-stub.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
