#!/usr/bin/env bash
# M29 维护套件:自动化事实状态(recordFired 不许改写挂载侧)+ 来源身份冻结
# (automationEventOrigin 的纯函数面)。详见 main.ts 文件头。
#
# 打包方式照 automation-smoke 的最小面:automationStatus 是纯模块;
# automationEventOrigin 拉着 SettingRepo → sql.js,所以要 dataRoot/logger 两个桩
# (run-store-smoke 那两份)+ 临时数据根 + `--banner` 给 sql.js 一个真 require。
# 只用 fixture,不触任何真实服务;跑完连临时目录一起删。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-maint-m29-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-maint-m29-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/maint-m29-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_DATA_ROOT="$DATA"
node "$OUT/smoke.mjs"
