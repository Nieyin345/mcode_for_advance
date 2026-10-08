#!/usr/bin/env bash
# activity-console-count-smoke — ActivityConsole 「已完成」计数与正文的口径漂移(见 main.ts 文件头)。
#
# ⚠️ 关键 alias:
#   - `react` / `react/jsx-runtime` → 极小 hooks 运行时(组件源码原样跑)。
#   - `@tabler/icons-react` 与 `react-icons/*` → 空壳 barrel(图标是惰性 JSX,从不被调用)。
# 不起服务、不碰磁盘、不连 IPC。
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=$(mktemp -d /tmp/mcode-activity-console-count.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"
"$ESBUILD" scripts/activity-console-count-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:react=./scripts/activity-console-count-smoke/fakeReact.ts \
  --alias:react/jsx-runtime=./scripts/activity-console-count-smoke/jsxRuntime.ts \
  --alias:@tabler/icons-react=./scripts/activity-console-count-smoke/iconsStub.cjs \
  --alias:react-icons/pi=./scripts/activity-console-count-smoke/iconsStub.cjs \
  --alias:react-icons/ri=./scripts/activity-console-count-smoke/iconsStub.cjs \
  --alias:react-icons/si=./scripts/activity-console-count-smoke/iconsStub.cjs \
  --alias:react-icons/vsc=./scripts/activity-console-count-smoke/iconsStub.cjs \
  --alias:@renderer/lib/monacoSetup.js=./scripts/activity-console-count-smoke/monaco-stub.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
