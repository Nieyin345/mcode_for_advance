#!/usr/bin/env bash
# Headless smoke for the monitoring-panel IPC route (`main/ipc/monitoring.ts`).
#
# ## ⚠️ 安全前提(这一套会真写盘)
#
# 真建一个 sqlite 库、真写 NDJSON。脚下那个数据根换成
# `mktemp -d` 出来的目录 —— `stubs/dataRoot.ts` 里那句"环境变量没设就**抛**"
# 是这套脚本能跑的前提,不是洁癖:**`sql.js` 的 `db.export()` 会重写整个
# `mcode.db`**,指到真库就是拿一个空库盖掉用户的聊天记录。监控摘要是 NDJSON,
# 同理必须落在临时目录里(断言里直接比对了路径)。
#
# ## 为什么要换桩
#
#  - **electron 整个包**:`store/db.ts` 与 `lib/logger.ts` 都 `import { app } from
#    "electron"` 拿 `app.getPath`。顺着 `--alias:@main/...` 一个个堵会变成打地鼠,
#    而漏掉一个报出来的是 esbuild 把真 electron 打成 CJS、`index.js` 里同时有
#    `require` 和顶层 await,Node 拒绝这个模块格式 —— 看着和"被测代码坏了"一模一样。
#    见 `stubs/electron.ts` 文件头;
#  - **dataRoot / logger**:真的那两个 import 了 electron。dataRoot 复用
#    run-store-smoke 的老桩(没设环境变量就**抛**);logger 是本目录自己的 ——
#    在"打到 stderr"之上多记一份,因为本套要验 `lookupWorkflowId` 那个 catch
#    到底留没留日志(静默吞掉和"吞了但留一行"在 stderr 上看起来一样);
#  - **monitoring/collector**:这一套要**数** `startMonitoringCollector` 被调了几次
#    ("采集器只挂一次"那一条的唯一判据)。但"每个通道都真的走一遍"要求 handler 注册的
#    是真东西,所以桩只换掉**装配那一个导出**,真的 `MonitoringCollector` 类与 store /
#    aggregate 全部走真的(`§5` 往 `mobileEventBus` 喂事件、断言盘上多一行);
#  - **monitoring/store**:记录 `readRunSummaries` 收到的 `limit`。理由见
#    `stubs/store.ts` 文件头:`monitoring.ts` 的下限夹取被 `store.ts` 的
#    "先 push 再比"遮住了,只有看传下去的那个数才验得出来。读写照旧转发给真实现;
#  - **monitoring/aggregate**:**不换** —— 它本来就是纯函数,真的那个喂得进。
#
# `--banner:js` 那一行**非有不可**:sql.js 的 asm 构建里有 `require("node:fs")`,
# 而定死的 ESM 输出没有 `require`(理由同 run-store-smoke/run.sh)。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-observability-ipc-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-observability-ipc-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# back to npx when absent.
ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/observability-ipc-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:electron=./scripts/observability-ipc-smoke/stubs/electron.ts \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/observability-ipc-smoke/stubs/logger.ts \
  --alias:@main/monitoring/collector.js=./scripts/observability-ipc-smoke/stubs/collector.ts \
  --alias:@main/monitoring/store.js=./scripts/observability-ipc-smoke/stubs/store.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_DATA_ROOT="$DATA"

node "$OUT/smoke.mjs"
