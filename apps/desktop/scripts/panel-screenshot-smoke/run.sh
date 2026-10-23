#!/usr/bin/env bash
# Headless smoke for 面板截图(app_ui action:screenshot_panel，报告 Q1)。
#
# 真截屏要起 Electron，无头验不了"像素对不对"。这套验**能验的那部分**：矩形裁剪纯函数、
# 存盘核、screenshot_panel 端到端(假窗 + 假 NativeImage)的"拿到矩形就截 / 拿不到就如实报错"。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-panel-screenshot.XXXXXX)
# 存盘核会真写文件 —— 指到本脚本自建的临时目录，绝不让它落到真实截图目录 / Pictures。
SHOT=$(mktemp -d /tmp/mcode-panel-shot.XXXXXX)
trap 'rm -rf "$OUT" "$SHOT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

export MCODE_SMOKE_SHOT_DIR="$SHOT"

"$ESBUILD" scripts/panel-screenshot-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/window.js=./scripts/panel-screenshot-smoke/stubs/window.ts \
  --alias:@main/claude/RuntimeManager.js=./scripts/app-control-smoke/stubs/runtimeManager.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:@renderer/stores/sessionStore.js=./scripts/panel-screenshot-smoke/stubs/session.ts \
  --alias:@renderer/stores/toastStore.js=./scripts/panel-screenshot-smoke/stubs/toast.ts \
  --alias:electron=./scripts/library-delete-smoke/stubs/electron.ts \
  --alias:@main/document/genofficeNativeVendor.js=./src/main/document/genofficeNativeVendorStub.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
