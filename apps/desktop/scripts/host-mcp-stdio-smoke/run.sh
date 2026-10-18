#!/usr/bin/env bash
# Headless smoke for **mcode-host-mcp 的 stdio 传输层 + 回环中继**(ARC-006 桥 2 第二片,见 main.ts 文件头)。
#
# 被测:
#   - src/main/mcp/hostMcpStdio.ts        NDJSON 帧 / initialize / tools/list / tools/call / 坏帧 / 未知方法 / stdin 关闭
#   - src/main/mcp/hostMcpRelayServer.ts  主进程侧回环 HTTP 中继(一次性令牌 + Host 围栏)
#   - src/main/mcp/hostMcpMain.ts         子进程入口(环境变量读中继地址与令牌)
#
# 两件产物,各打各的:
#   1. `.tmp/host-mcp-stdio-smoke/child.mjs` —— **子进程入口**,必须与生产同形:只依赖
#      node 内建(handMcpStdio / hostMcpMain 的 runtime import 图里没有 electron / sql.js)。
#      不起任何 alias —— 它要是拖进了 electron,这里就会当场炸,那正是我们要的判据。
#   2. `.tmp/host-mcp-stdio-smoke/smoke.mjs` —— 驱动:起中继(真 `createHostMcpServer` +
#      真 `appMcpTools()`),再 spawn 上面那个产物喂 JSON-RPC。
#      它 import `@main/appControl/tools.ts`,import 图很宽 —— 替身与 **host-mcp-server-smoke
#      逐字相同**(同一组 alias、同一个理由;不另抄一份新桩)。
#
# `--external:ssh2` 与产物位置同 host-mcp-server-smoke:ssh2 的 import 运行时解析,产物必须在
# 仓库 `.tmp/` 下才找得到 node_modules。
set -euo pipefail
cd "$(dirname "$0")/../.."

mkdir -p ./.tmp/host-mcp-stdio-smoke
source "$(dirname "$0")/../lib/esbuild-path.sh"

# 1) 子进程入口 —— 与生产同形:ELECTRON_RUN_AS_NODE=1 时它就是 Node 语义,不带任何替身。
"$ESBUILD" src/main/mcp/hostMcpMain.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile=./.tmp/host-mcp-stdio-smoke/child.mjs --log-level=error

# 2) 驱动。stub 组与 host-mcp-server-smoke 一致(理由见那个 suite 的 run.sh 文件头):
#    - `@main/claude/RuntimeManager.js` 换成显式抛错的替身(无窗口路径会动态 import 整条
#      provider 图 + ssh2 原生模块,打包阶段就会卡住);
#    - `store/repositories.ts` / `lib/logger.ts` / `lib/dataRoot.ts` / `electron` / `window.ts`
#      都碰 electron,换成各 suite 目录里现成的实现。
"$ESBUILD" scripts/host-mcp-stdio-smoke/main.ts \
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
  --outfile=./.tmp/host-mcp-stdio-smoke/smoke.mjs --log-level=error

# 本套不碰持久化;数据根仍给临时目录(任何意外路径都不许落到用户真实数据根 ——
# dataRoot 桩在未设变量时直接抛,这里给上)。
DATA=$(mktemp -d /tmp/mcode-host-mcp-stdio-smoke-data.XXXXXX)
trap 'rm -rf "$DATA"' EXIT
MCODE_SMOKE_DATA_ROOT="$DATA" \
MCODE_HOST_MCP_STDIO_CHILD="$(pwd)/.tmp/host-mcp-stdio-smoke/child.mjs" \
node ./.tmp/host-mcp-stdio-smoke/smoke.mjs
