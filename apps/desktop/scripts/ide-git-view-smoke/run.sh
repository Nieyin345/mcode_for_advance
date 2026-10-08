#!/usr/bin/env bash
# ide-git-view-smoke — GitHistoryView 的提交详情回包竞态(见 main.ts 文件头)。
#
# ⚠️ 关键的两个 `--alias`:
#   - `react` / `react/jsx-runtime` → maint-m32-smoke 那套极小 hooks 运行时。这个仓库里
#     没有 jsdom / react-test-renderer(也不许联网装),而要验的回包竞态只在 effect 真跑、
#     setState 真落地时才显形 —— 于是换调度器,组件源码原样跑。
#   - `@renderer/lib/api.js` → 可扣回包的内存桩。不连主进程、不连 git。
#   - `@tabler/icons-react` → 空壳(几千导出的 barrel,图标在惰性 JSX 里从不会被调用)。
#
# 不起服务、不碰磁盘。
set -euo pipefail
cd "$(dirname "$0")/../.."          # → apps/desktop

OUT=$(mktemp -d /tmp/mcode-ide-git-view.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/ide-git-view-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:react=./scripts/ide-git-view-smoke/fakeReact.ts \
  --alias:react/jsx-runtime=./scripts/ide-git-view-smoke/jsxRuntime.ts \
  --alias:@tabler/icons-react=./scripts/ide-git-view-smoke/iconsStub.cjs \
  --alias:@renderer/lib/api.js=./scripts/ide-git-view-smoke/api-stub.ts \
  --external:@renderer/lib/monacoSetup.js \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
