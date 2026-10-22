#!/usr/bin/env bash
# T3｜Node-RED 工作流触发器单一归属门禁 —— 无头冒烟。
#
# 证明 `engine=node-red` 的图**不会再被旧 automationRunner 装上 cron / fs.watch /
# 事件订阅**（修复前真的是双监听：真短周期 cron + 真 fs.watch + 真事件，都由
# `startWorkflowRun` 桩记下次数），同时无 engine 的历史图照旧运行。
#
# 写法与 `automation-smoke` 同一路：esbuild 打包 + 换桩 + 纯 node 跑。
# `automationRunner` 里 `from "./runner.js"` 是**相对** import，`--alias:` 不收，
# 所以整条外置（见 stubs/runner.ts 文件头）。
#
# ⚠️ 这一套会**真的 `new` 一个 `AutomationRunner` 并 `start()`** —— 它会往 settings
# 表写 `automation.lastMinute`（`SettingRepo.set` 内部 `persist()` **重写整个
# `mcode.db`**）。`MCODE_SMOKE_DATA_ROOT` 指向真库等于毁数据；临时目录不是洁癖，是
# 这套脚本能跑的前提。同时它会往项目目录真写文件、真开 `fs.watch` —— 目录也在临时
# 数据根之下。
set -euo pipefail
cd "$(dirname "$0")/../.."     # → apps/desktop

# 建在 apps/desktop/.tmp 下（与 executor-owner-cross-process-cas-smoke 同一取舍）：
# `--external:` 的包要在运行时被解析到，`/tmp` 下的 bundle 走不到本包 node_modules。
mkdir -p ./.tmp
OUT=$(mktemp -d ./.tmp/mcode-t3-gate-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-t3-gate-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT

source scripts/lib/esbuild-path.sh

# ── 外置桩：`@main/orchestration/runner.js` 的替身（两层转发，见 automation-smoke/run.sh）──
"$ESBUILD" scripts/t3-engine-trigger-gate-smoke/stubs/runner.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/stubs/runner.js" --log-level=error
printf 'export * from "./stubs/runner.js";\n' > "$OUT/runner.js"

"$ESBUILD" scripts/t3-engine-trigger-gate-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --external:./runner.js \
  --external:./stubs/runner.js \
  --external:sherpa-onnx-node \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:@main/claude/RuntimeManager.js=./scripts/t3-engine-trigger-gate-smoke/stubs/runtimeManager.ts \
  --alias:@main/plugins/pluginManager.js=./scripts/mcode-admin-smoke/stubs/pluginManager.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/smoke.mjs"
