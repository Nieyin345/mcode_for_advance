#!/usr/bin/env bash
# maint-m32-smoke — 手机端 Git 面板的旧回包回写(见 main.ts 文件头)。
#
# ⚠️ **不起服务、不连 LAN、不碰真手机、不写磁盘**:`fetch` 是内存里的假主进程,
#    所以这里没有 `MCODE_SMOKE_DATA_ROOT`。
#
# 两个 `--alias` 是这套的关键:
#   - `react` / `react/jsx-runtime` → 本目录的极小 hooks 运行时。这个仓库里没有
#     jsdom / react-test-renderer(也不许联网装),而要验的竞态只在 effect 真跑、
#     setState 真落地时才显形 —— 于是换调度器,**组件源码原样跑**。
#   - `@tabler/icons-react` → 空壳。那是个几千个导出的 barrel,打进来只会让这套
#     慢十几秒;图标在惰性 JSX 里从不会被调用。
set -euo pipefail
cd "$(dirname "$0")/../.."          # → apps/desktop

OUT=$(mktemp -d /tmp/mcode-maint-m32.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/maint-m32-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:react=./scripts/maint-m32-smoke/fakeReact.ts \
  --alias:react/jsx-runtime=./scripts/maint-m32-smoke/jsxRuntime.ts \
  --alias:@tabler/icons-react=./scripts/maint-m32-smoke/iconsStub.cjs \
  --external:@renderer/lib/monacoSetup.js \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
