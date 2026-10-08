#!/usr/bin/env bash
# settings-project-race-smoke — 项目插件/MCP 设置页切项目后的旧回包回写(见 main.ts 文件头)。
#
# ⚠️ 关键 alias:
#   - `react` / `react/jsx-runtime` → 极小 hooks 运行时(组件源码原样跑)。
#   - `@renderer/lib/api.js` → **能扣住回包**的替身。
#   - `./ScopeTabs.js` → ProjectPicker 直通桩(靠换 prop 切项目,不靠点选)。
#   - ui / icons / monaco → 直通桩。
#
# 不起服务、不碰磁盘。
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=$(mktemp -d /tmp/mcode-settings-project-race.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"
"$ESBUILD" scripts/settings-project-race-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:react=./scripts/settings-project-race-smoke/fakeReact.ts \
  --alias:react/jsx-runtime=./scripts/settings-project-race-smoke/jsxRuntime.ts \
  --alias:@tabler/icons-react=./scripts/settings-project-race-smoke/iconsStub.cjs \
  --alias:@renderer/lib/api.js=./scripts/settings-project-race-smoke/api-stub.ts \
  --alias:@renderer/components/ui/index.js=./scripts/settings-project-race-smoke/ui-stub.ts \
  --alias:@renderer/lib/monacoSetup.js=./scripts/settings-project-race-smoke/monaco-stub.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
