#!/usr/bin/env bash
# Headless smoke for **场景部署执行端**(MC-058 / ARC-002 的 dry-run + apply)。
#
# 被测:`@main/appServices/sceneDeploy.ts`(`dryRunScene` / `applyScene`)+ 它派发所经的
# `@main/appControl/tools.ts`(`findEntry` / `callRpc`,与 `app_api_call` **同一条**通路)+
# 记录持久化 `@main/appServices/sceneDeploymentStore.ts` → `scene_deployments` 表。
#
# ## 为什么这套要真建库
#
# `applyScene` 每一步都 `saveDeployment({durable:true})` —— 「逐步落盘、崩溃可续」只有真写一次
# `scene_deployments` 才验得了。脚下那个数据根换成临时目录(见 run-store-smoke/stubs/dataRoot.ts
# 里那句"没设就抛":指错地方等于拿空库盖掉用户的聊天记录)。
#
# ## 它不碰真 Electron / 真无窗口运行时
#
# `tools.ts` 的链 import electron 且动态 import RuntimeManager(见 app-control-smoke/run.sh 的
# 警告),这里照该套的取舍整套换桩;`dataRoot` 换临时目录桩。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-scene-apply.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-scene-apply-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT

source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/scene-apply-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/window.js=./scripts/app-control-smoke/stubs/window.ts \
  --alias:@main/claude/RuntimeManager.js=./scripts/app-control-smoke/stubs/runtimeManager.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:electron=./scripts/library-delete-smoke/stubs/electron.ts \
  --alias:@main/document/genofficeNativeVendor.js=./src/main/document/genofficeNativeVendorStub.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/smoke.mjs"
