#!/usr/bin/env bash
# Headless smoke for **mcode-host-mcp 的纯逻辑核心**(ARC-006 桥 2 第一片,见 main.ts 文件头)。
#
# 被测:src/main/mcp/hostMcpServer.ts —— 工具表投影 / 请求分发 / 审批档与 fail-closed。
# 同时用**真** `invokeAppTool` 并排验证「安全档无审批端口」与 Agent 侧口径一致。
#
# ⚠️ 本套 import `@main/appControl/tools.ts`,它的 import 图很宽:
#   - 无窗口路径会**动态** import `RuntimeManager`(整条 provider 图 + ssh2 原生模块)——
#     打包阶段就会卡住,故 `--alias` 换显式抛错的替身(与 app-control-smoke 同款);
#   - `store/repositories.ts` 会拉进真 sql.js 库;本套只读一读设置/工作流表,换成
#     内存表替身(SettingRepo)即可,其余原样转发;
#   - `lib/dataRoot.ts` / `lib/logger.ts` / `electron` / `window.ts` 都碰 electron。
# 替身**复用** app-control-smoke / run-store-smoke / library-delete-smoke 目录里的
# 现成实现(形状与那几套逐字相同,不另抄一份)。
#
# `--external:ssh2`:ssh2 的 import 运行时解析,故产物必须放在 `.tmp/` 下(从产物目录
# 往上才能找到仓库的 node_modules;/tmp 在 Windows 上找不到)。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."

mkdir -p ./.tmp/host-mcp-server-smoke
source "$HERE/../lib/esbuild-path.sh"

# `--banner` 那一行非有不可:sql.js 的 asm 构建里有 `require("node:fs")`,而定死的
# ESM 输出没有 `require`,esbuild 会把它换成一句抛错。
"$ESBUILD" scripts/host-mcp-server-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --external:ssh2 \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/window.js=./scripts/app-control-smoke/stubs/window.ts \
  --alias:@main/claude/RuntimeManager.js=./scripts/app-control-smoke/stubs/runtimeManager.ts \
  --alias:@main/store/repositories.js=./scripts/app-control-smoke/stubs/repositories.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:electron=./scripts/library-delete-smoke/stubs/electron.ts \
  --alias:@main/document/genofficeNativeVendor.js=./src/main/document/genofficeNativeVendorStub.ts \
  --outfile=./.tmp/host-mcp-server-smoke/smoke.mjs --log-level=error

# 本套不碰持久化(SettingRepo 是内存替身、不写库);数据根仍给临时目录,免得任何
# 意外路径落到用户真实数据根 —— dataRoot 桩在未设变量时直接抛,这里给上。
DATA=$(mktemp -d /tmp/mcode-host-mcp-smoke-data.XXXXXX)
trap 'rm -rf "$DATA"' EXIT
MCODE_SMOKE_DATA_ROOT="$DATA" node ./.tmp/host-mcp-server-smoke/smoke.mjs
