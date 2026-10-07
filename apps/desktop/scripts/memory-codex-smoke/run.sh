#!/usr/bin/env bash
# Headless smoke for `main/ipc/memory.ts` + `main/ipc/codexModels.ts`(+ 总注册表
# `main/ipc/index.ts`)。跑真的 handler、真的写文件、真的生成 config.toml ——
# 脚下换成两个 mktemp 出来的临时目录,跑完连目录一起删。
#
# ## ⚠️ 为什么别名一大串
#
# §4 要真的调 `registerIpcHandlers()` —— 那座总注册表把 **37 个域**串起来,import 图
# 是**整个主进程**。碰 electron 的地方一路数不清,所以直接把整个 `electron` 包换成本套
# 的桩(见 `stubs/electron.ts`,它的 `ipcMain` 是**记名替身**,重复注册当场抛)。
# 其余每一条 alias 都是那棵树里被 import 到、又不能让它真跑起来的模块。
#
# ## ⚠️ `--banner:js` 那一行非有不可,而且比别的套件长
#
# 短的那半是给 sql.js 的:它的 asm 构建里有 `require("node:fs")`,而定死的 ESM 输出
# 没有 `require`。长的那半是 `__dirname` —— `notifications/NotificationManager.ts`
# 顶层有一句 `join(__dirname, "../../build/icon.png")`,ESM 作用域里没有它。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-memcodex-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-memcodex-data.XXXXXX)
HOMEDIR=$(mktemp -d /tmp/mcode-memcodex-home.XXXXXX)
# 给 bundle 一个 node_modules 视野(打包产物是 ESM,`--packages=external` 留了几条
# 由它自己 `import` 的依赖,运行期从 bundle 的位置解析)。
ln -s "$PWD/node_modules" "$OUT/node_modules"
trap 'rm -rf "$OUT" "$DATA" "$HOMEDIR"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/memory-codex-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --loader:.md=text --loader:.py=text --loader:.txt=text --loader:=text \
  --packages=external \
  --banner:js="import { createRequire as __cr } from 'node:module'; import { fileURLToPath as __fup } from 'node:url'; import { dirname as __dn } from 'node:path'; const require = __cr(import.meta.url); const __dirname = __dn(__fup(import.meta.url));" \
  --alias:electron=./scripts/memory-codex-smoke/stubs/electron.ts \
  --alias:@main/lib/dataRoot.js=./scripts/memory-codex-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:@main/window.js=./scripts/projects-ipc-smoke/stubs/window.ts \
  --alias:@main/claude/RuntimeManager.js=./scripts/frontend-smoke/stubs/runtimeManager.ts \
  --alias:@main/plugins/pluginManager.js=./scripts/memory-codex-smoke/stubs/pluginManager.ts \
  --alias:@main/mobile/MobileEventBus.js=./scripts/projects-ipc-smoke/stubs/mobileEventBus.ts \
  --alias:@main/lib/pendingBackflow.js=./scripts/projects-ipc-smoke/stubs/pendingBackflow.ts \
  --alias:@main/orchestration/runner.js=./scripts/claude-ipc-smoke/stubs/runner.ts \
  --alias:@main/ipc/titleGen.js=./scripts/claude-ipc-smoke/stubs/titleGen.ts \
  --alias:@main/providers/registry.js=./scripts/claude-ipc-smoke/stubs/providerRegistry.ts \
  --alias:@main/lib/mcpConfig.js=./scripts/memory-codex-smoke/stubs/mcpConfig.ts \
  --alias:@main/lib/mcpEngines.js=./scripts/memory-codex-smoke/stubs/mcpEngines.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

# ⚠️ 两个变量都是**安全前提**,不是一个指纹:
#   - `MCODE_SMOKE_DATA_ROOT` —— sql.js 的 `db.export()` 重写整个 `mcode.db`;
#     指到真数据根 = 拿空库盖掉用户的聊天记录。桩里没设时**直接抛**。
#   - `USERPROFILE` / `HOME` —— `codexModelsStore.codexHomePath()` 是
#     `homedir()/.mcode/codex`,指的若是真的家目录,这套会**改写用户在用的
#     config.toml**。homedir() 在 win32 下读 `USERPROFILE`(libuv,不是 env 缓存),
#     两个都给上,两个平台都盖住。
export MCODE_SMOKE_DATA_ROOT="$DATA"
export USERPROFILE="$HOMEDIR"
export HOME="$HOMEDIR"

node "$OUT/smoke.mjs"
