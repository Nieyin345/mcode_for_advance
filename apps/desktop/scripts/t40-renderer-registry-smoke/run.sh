#!/usr/bin/env bash
# 【T40】生产装配路径上的渲染端工具登记簿。
#
# 这套**真调** `registerIpcHandlers()`（总注册表，37 个域），然后从 `documentViewHost`
# 里取出它真正收到的 `docsAiPorts`，断言那一份是**包装过**的。
#
# ## 为什么别名这么长
#
# 与 `memory-codex-smoke` 同一个理由：总注册表的 import 图就是整个主进程，碰 electron
# 的地方一路数不清。所以把整个 `electron` 包换成本套的桩；其余每条 alias 都是那棵树里
# 被 import 到、又不能让它真跑起来的模块。
#
# ## 安全前提
#
# `MCODE_SMOKE_DATA_ROOT` 必须指临时目录 —— sql.js 的 `db.export()` 重写整个
# `mcode.db`，指到真数据根 = 拿空库盖掉用户的聊天记录。桩里没设时**直接抛**。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."

OUT=$(mktemp -d /tmp/mcode-t40-registry.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-t40-registry-data.XXXXXX)
HOMEDIR=$(mktemp -d /tmp/mcode-t40-registry-home.XXXXXX)
source scripts/lib/runtime-node-modules.sh
mcode_link_runtime_node_modules "$OUT" "$PWD/node_modules"
trap 'rm -rf "$OUT" "$DATA" "$HOMEDIR"' EXIT
source "$HERE/../lib/esbuild-path.sh"

"$ESBUILD" scripts/t40-renderer-registry-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --loader:.md=text --loader:.py=text --loader:.txt=text --loader:=text \
  --packages=external \
  --banner:js="import { createRequire as __cr } from 'node:module'; import { fileURLToPath as __fup } from 'node:url'; import { dirname as __dn } from 'node:path'; const require = __cr(import.meta.url); const __dirname = __dn(__fup(import.meta.url));" \
  --alias:electron=./scripts/t40-renderer-registry-smoke/stubs/electron.ts \
  --alias:@main/lib/dataRoot.js=./scripts/t40-renderer-registry-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:@main/window.js=./scripts/projects-ipc-smoke/stubs/window.ts \
  --alias:@main/claude/RuntimeManager.js=./scripts/frontend-smoke/stubs/runtimeManager.ts \
  --alias:@main/plugins/pluginManager.js=./scripts/t40-renderer-registry-smoke/stubs/pluginManager.ts \
  --alias:@main/mobile/MobileEventBus.js=./scripts/projects-ipc-smoke/stubs/mobileEventBus.ts \
  --alias:@main/lib/pendingBackflow.js=./scripts/projects-ipc-smoke/stubs/pendingBackflow.ts \
  --alias:@main/orchestration/runner.js=./scripts/claude-ipc-smoke/stubs/runner.ts \
  --alias:@main/ipc/titleGen.js=./scripts/claude-ipc-smoke/stubs/titleGen.ts \
  --alias:@main/providers/registry.js=./scripts/claude-ipc-smoke/stubs/providerRegistry.ts \
  --alias:@main/lib/mcpConfig.js=./scripts/memory-codex-smoke/stubs/mcpConfig.ts \
  --alias:@main/lib/mcpEngines.js=./scripts/memory-codex-smoke/stubs/mcpEngines.ts \
  --alias:@main/document/slidesVendorModules.js=./src/main/document/slidesVendorModulesStub.ts \
  --alias:@main/document/genofficeNativeVendor.js=./src/main/document/genofficeNativeVendorStub.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_DATA_ROOT="$DATA"
export USERPROFILE="$HOMEDIR"
export HOME="$HOMEDIR"

node "$OUT/smoke.mjs"
