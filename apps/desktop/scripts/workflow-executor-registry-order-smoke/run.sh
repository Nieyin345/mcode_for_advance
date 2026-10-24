#!/usr/bin/env bash
# 【W4】执行器注册表「可用性判据的时机」回归 —— 单例在端口注入后才注册 node-red。
#
# 一套 = 真 handler（fakeIpc 记名）+ 真场景预检服务 + 真执行器注册表单例。
# 与 orchestration-ipc-smoke 同一套换桩：electron / dataRoot / logger / window /
# pluginManager / RuntimeManager 都要替 —— 被测文件 `ipc/orchestration.ts` 的
# import 图把它们全拉了进来。
#
# ⚠️ 数据根指向 `mktemp -d`（`stubs/dataRoot.ts` 里"没设就抛"）：本套会建库、写
# 工作流行 —— `sql.js` 的 `db.export()` 重写整个 `mcode.db`。指错地方就是拿空库
# 盖掉用户的聊天记录。临时目录不是洁癖，是这套脚本能跑的前提。
set -euo pipefail
cd "$(dirname "$0")/../.."

# 建在 apps/desktop 下而不是 /tmp —— `--external:ssh2` 要在运行时解析到本包 node_modules。
mkdir -p ./.tmp
OUT=$(mktemp -d ./.tmp/mcode-w4-registry-order.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-w4-registry-order-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT

source "scripts/lib/esbuild-path.sh"

# `--loader:` 那一组是 Vite `?raw` 的等价物（`ipc/orchestration.ts` → `workflows/seed.ts`
# 拉进二十几个 .py/.md/.txt/无后缀的 LICENSE）。`--banner` 是给 sql.js 的：它的 asm
# 构建里有 `require("node:fs")`，而定死的 ESM 输出没有 `require`。
"$ESBUILD" scripts/workflow-executor-registry-order-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --external:ssh2 \
  --loader:.md=text --loader:.py=text --loader:.txt=text --loader:=text \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:electron=./scripts/orchestration-ipc-smoke/stubs/electron.ts \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:@main/window.js=./scripts/orchestration-ipc-smoke/stubs/window.ts \
  --alias:@main/claude/RuntimeManager.js=./scripts/frontend-smoke/stubs/runtimeManager.ts \
  --alias:@main/plugins/pluginManager.js=./scripts/orchestration-ipc-smoke/stubs/pluginManager.ts \
  --alias:@main/document/genofficeNativeVendor.js=./src/main/document/genofficeNativeVendorStub.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_DATA_ROOT="$DATA"
node "$OUT/smoke.mjs"
