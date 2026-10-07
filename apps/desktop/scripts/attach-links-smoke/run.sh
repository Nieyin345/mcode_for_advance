#!/usr/bin/env bash
# Headless smoke for 引用时自动挂载关联(一跳):attachToChat 推了几条 composer:attach。
#
# 那段代码 import 了 electron 侧的东西(`@main/window.js` 的 sendToRenderer、
# `@main/claude/RuntimeManager.js`),换掉(见 stubs/)。被测的那份代码一行都没改。
#
# 脚下数据根换成临时目录(见 stubs/dataRoot.ts 里那句"没设就抛":指错地方就是拿
# 一个空库盖掉用户的聊天记录)。真正的库外文件也是 main.ts 自己在 tmp 里建的。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-attach-links-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-attach-links-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

# `main.ts` 用**相对路径** import 桩(绕开 @main 映射,typecheck 才不会去对真模块
# 要测试钩子);run.sh 这里再把被测代码内部的引用也指过去 —— 两个入口解析到同一个
# 文件,bundle 里就是同一个模块实例,`sent` 数组两边看得见。
"$ESBUILD" scripts/attach-links-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/lib/dataRoot.js=./scripts/attach-links-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/attach-links-smoke/stubs/logger.ts \
  --alias:@main/window.js=./scripts/attach-links-smoke/stubs/window.ts \
  --alias:@main/claude/RuntimeManager.js=./scripts/attach-links-smoke/stubs/runtimeManager.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_DATA_ROOT="$DATA"

node "$OUT/smoke.mjs"
