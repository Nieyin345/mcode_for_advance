#!/usr/bin/env bash
# 【W19】`nodePackProductionPorts.ts` 的生产端口回归 —— **与 `mcode-node-pack-smoke`
# 验的是两个不同的东西**,两套都要跑:
#
#   - `mcode-node-pack-smoke`(393 条):把生产端口**换成抛错的桩**,验「节点外壳 +
#     Node-RED 接线」;
#   - 本套:保留生产端口,把四个宿主依赖换桩,验「生产端口交给宿主什么、拒绝什么」
#     —— 三条安全边界(路径围栏 / 部署审批 / projectPath 授权)只在这里被驱动。
#
# ## 换桩的边界(逐条理由见各 stub 文件头)
#
#   - `electron` —— 记录型:弹窗返回值由脚本喂、按钮文案逐条记下来;
#   - `@main/window.js` —— 可摆「有窗口 / 无窗口 / 窗口已销毁」;
#   - `@main/claude/RuntimeManager.js` —— 可摆「正常/报错/中断/没有 turn.done/忙」;
#   - `@main/modules/service.js` —— 记录 `invoke` 收到的 payload(不初始化真 ModuleHost)。
#   - `@main/lib/dataRoot.js` / `@main/lib/logger.js` —— 仓库标准的两份(临时数据根 /
#     日志原样进 stderr)。
#
# 真身留下的是 `SessionRepo` / `ProjectRepo`(sql.js)——「会话不存在 / 不是 chat /
# provider 不支持」这三条拒绝要靠**真库**里真查不到才可信,自己写一份内存表就是
# 验副本(CLAUDE.md 第二十六条)。
#
# ⚠️ **数据根必须是 `mktemp -d`**:`SessionRepo.create` 内部是 `persist()`,会**重写整个
# `mcode.db`**。指到真库等于毁数据 —— `stubs/dataRoot.ts` 那句「没设环境变量就抛」
# 就是为这件事,别去改它。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."

OUT=$(mktemp -d /tmp/mcode-node-pack-ports-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-node-pack-ports-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT

source "$HERE/../lib/esbuild-path.sh"

"$ESBUILD" scripts/mcode-node-pack-ports-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:electron=./scripts/mcode-node-pack-ports-smoke/stubs/electron.ts \
  --alias:@main/window.js=./scripts/mcode-node-pack-ports-smoke/stubs/window.ts \
  --alias:@main/claude/RuntimeManager.js=./scripts/mcode-node-pack-ports-smoke/stubs/runtimeManager.ts \
  --alias:@main/modules/service.js=./scripts/mcode-node-pack-ports-smoke/stubs/moduleService.ts \
  --alias:@main/orchestration/extensionCommandPort.js=./scripts/mcode-node-pack-ports-smoke/stubs/extensionCommandPort.ts \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/smoke.mjs"
