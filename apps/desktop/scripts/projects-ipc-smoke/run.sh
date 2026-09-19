#!/usr/bin/env bash
# Headless smoke for **`main/ipc/projects.ts`** —— 项目 / 会话的增删改与列表分页。
#
# 这一套押在"删东西"和"分页"这两类上,因为它们的错法用户**一定会信**:
#
#   - 删一个项目 = 级联删掉它下面**每一条**会话。而 `SESSION_DELETE` 上写着两句
#     "不能省"的收尾(停掉还在跑的图、清掉待并回的内容)。级联删是**静默**的,
#     不会逐条走那个 handler —— 所以项目那条路上必须自己补,漏了没有任何提示。
#   - 分页的 `hasMore` / `total` 一旦和 `list` 的过滤口径对不上,底部那个「显示更多」
#     就会永远显示、或者提前消失,而列表本身看起来完全正常。
#
# ## 换桩的边界
#
#   - `@main/window.js` —— 广播要留**真的**记录,所以只替掉窗口本身(`sendToRenderer`);
#   - `@main/mobile/MobileEventBus.js` —— 手机端那条 SSE 要能看到**发了什么**;
#   - `@main/orchestration/runner.js` —— `cancelWorkflowRun` 在 `PROJECT_DELETE` 里
#     被逐个会话调用,真的那份会去动调度器。**必须**换掉,而且返回值要有意义
#     (见那个桩里 `activeRuns` 那段);
#   - `@main/lib/pendingBackflow.js` —— 内存态,换掉才能断言"清掉了"。
#
# ⚠️ **数据根必须是 `mcode.db` 的副本。** 这一套真建库、真写行、真删(内部都是
# `persist()`,**重写整个库文件**)。`stubs/dataRoot.ts` 那句"没设环境变量就抛"就是
# 为这件事。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-projects-ipc-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-projects-ipc-data.XXXXXX)
ln -s "$PWD/node_modules" "$OUT/node_modules"
trap 'rm -rf "$OUT" "$DATA"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

"$ESBUILD" scripts/projects-ipc-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:electron=./scripts/library-delete-smoke/stubs/electron.ts \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:@main/window.js=./scripts/projects-ipc-smoke/stubs/window.ts \
  --alias:@main/mobile/MobileEventBus.js=./scripts/projects-ipc-smoke/stubs/mobileEventBus.ts \
  --alias:@main/orchestration/runner.js=./scripts/projects-ipc-smoke/stubs/runner.ts \
  --alias:@main/lib/pendingBackflow.js=./scripts/projects-ipc-smoke/stubs/pendingBackflow.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_DATA_ROOT="$DATA"

node "$OUT/smoke.mjs"
