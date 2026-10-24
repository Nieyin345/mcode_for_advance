#!/usr/bin/env bash
# 【ARC-002】app_guide(topic) 统一教程入口的无头回归。
# esbuild 打包 + node 直跑,不进 Electron。含一段**真 DB + 真 ModuleHost** 的活路径:
# 数据根指向 mktemp(SettingRepo 走内存桩,WorkflowRepo 走真库 —— sql.js 的 persist()
# 会重写整个 mcode.db,指错就是毁用户数据)。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."          # → apps/desktop

OUT=$(mktemp -d /tmp/mcode-agent-guide.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-agent-guide-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT
source "$HERE/../lib/esbuild-path.sh"

# 换桩口径与 app-control-smoke 一致(本套经 invokeAppTool 走真工具表):
#   - electron 整包替掉(dataRoot/dialogText 链上有 electron);
#   - dataRoot 指临时目录(桩在环境变量没设时直接抛);
#   - repositories 换内存 SettingRepo(发布表不碰 sql.js),其余仓库原样转发真模块;
#   - window / RuntimeManager 只为打包成形(tools.ts 的界面/无窗口两条路不走这里)。
"$ESBUILD" scripts/agent-guide-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:electron=./scripts/library-delete-smoke/stubs/electron.ts \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:@main/store/repositories.js=./scripts/agent-guide-smoke/stubs/repositories.ts \
  --alias:@main/window.js=./scripts/app-control-smoke/stubs/window.ts \
  --alias:@main/claude/RuntimeManager.js=./scripts/app-control-smoke/stubs/runtimeManager.ts \
  --alias:@main/document/genofficeNativeVendor.js=./src/main/document/genofficeNativeVendorStub.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/smoke.mjs"
