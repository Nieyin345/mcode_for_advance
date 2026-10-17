#!/usr/bin/env bash
# Headless smoke for 场景预检服务(ARC-002 / MC-058)。esbuild 打包 + node 直跑。
# 三个宿主依赖(provider 注册表 / 已启用插件 / 执行器注册表)换桩,不碰磁盘、不起 Electron。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-scene-preflight-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/scene-preflight-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:@main/providers/registry.js=./scripts/scene-preflight-smoke/stubs/registry.ts \
  --alias:@main/plugins/pluginManager.js=./scripts/scene-preflight-smoke/stubs/pluginManager.ts \
  --alias:@main/orchestration/executionEngine.js=./scripts/scene-preflight-smoke/stubs/executionEngine.ts \
  --alias:@main/modules/service.js=./scripts/scene-preflight-smoke/stubs/moduleService.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
