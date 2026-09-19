#!/usr/bin/env bash
# Headless smoke for **两件会动用户东西、却一套测试都没有的模块**:
#   - `src/main/session/AutoArchiver.ts`(自动归档,替用户改会话的可见状态)
#   - `src/main/runtimes/runtimeInstaller.ts`(按需安装内核:真的删/覆盖/移动磁盘)
#
# ## 两趟,两个进程
#
#   - **main.ts** —— 主体:归档语义 + 从本地路径安装/删除(真的建目录、真的剪枝)。
#   - **clean.ts** —— “干净机器”那一趟:一个内核来源都探不到时 `listRuntimes` 交出去
#     的东西对不对。它**必须**是单独的 bundle:现场靠的是“bundle 旁边没有
#     `node_modules`”(三个 probe 用 `createRequire` / `import.meta.resolve` 从
#     bundle 自己位置解析,解析不到就如实返回 null)。而 main.ts 那一趟**非有
#     `node_modules` 不可** —— 它的 `await import("tar")` 是运行期解析的。两者不能
#     同时成立,所以拆两趟。`clean` 那一趟用 `stubs/electron-clean.ts`(它必须让
#     `app.getAppPath()` 给出**真的** apps/desktop,否则钉版会退到代码里的兜底常量,
#     断言就成了自证)。
#
# ## 数据必须落在临时目录(两处,两处都会毁东西)
#
#   - **数据根**:`MCODE_SMOKE_DATA_ROOT` → 本脚本 `mktemp` 出来的目录。`db.ts` 会往
#     那儿写 `mcode.db`,而 sql.js 的 persist 是**重写整个文件** —— 指到真库就是拿
#     一套夹具会话盖掉用户的聊天记录(见 stubs/dataRoot.ts:没设就抛)。
#   - **runtimes 根**:`MCODE_SMOKE_RUNTIME_ROOT` → 另一个 `mktemp`。installer 会往
#     它里面复制、rename、`rmSync(recursive)` 整个版本目录 —— 指到真目录就是删掉
#     用户花几百 MB 下下来的内核。两个入口(main.ts / clean.ts)都在第一次调
#     installer 之前 `setManagedRuntimeRoot()` 指过去,并且**先断言设上了**再往下走。
#     ⚠️ 这一步是安全前提,不是装饰:managedRuntimeRoots 在无头脚本下 root 本来是
#     null,那时 installer 会落到 `app.getPath("userData")`(用户真实目录)。
#
# ## 别名
#
#   - **electron 整个包** —— 这两个模块本身不直接用 electron,但 import 图里有:
#     `lib/logger.ts` / `lib/dataRoot.ts` 用 `app`。整包换掉比一个个堵窄也准
#     (同 library-delete-smoke 的取舍,见其 stubs/electron.ts);
#   - **window** —— 真那个拿着 BrowserWindow,本套要断言进度推给界面了;
#   - **sessionSync** —— 真那个要用 mobileEventBus,本套要断言归档广播了;
#   - **dataRoot / logger** —— db-migrate-smoke 的老桩,db.ts 的两个依赖。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-archiver-installer-smoke.XXXXXX)
CLEAN_OUT=$(mktemp -d /tmp/mcode-archiver-installer-clean.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-archiver-installer-data.XXXXXX)
RUNTIMES=$(mktemp -d /tmp/mcode-archiver-installer-runtimes.XXXXXX)
RUNTIMES_CLEAN=$(mktemp -d /tmp/mcode-archiver-installer-runtimes-clean.XXXXXX)
trap 'rm -rf "$OUT" "$CLEAN_OUT" "$DATA" "$RUNTIMES" "$RUNTIMES_CLEAN"' EXIT

# ⚠️ **只给主体那一趟** node_modules 视野。clean 那一趟**故意不给** —— 那正是它
# “探不到任何来源”的全部实现。tar 是通过 `await import("tar")` 在**运行期**从
# bundle 自己的位置解析的,而 bundle 在临时目录里、那儿没有 node_modules。
# 软链一份真的进去,而不是设 NODE_PATH(后者只管 CJS,而 tar 7 的入口是 ESM)。
ln -s "$PWD/node_modules" "$OUT/node_modules"

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

# `--banner` 那一行是给 **sql.js** 的:它的 asm 构建里有 `require("node:fs")`,而定死的
# ESM 输出没有 `require`(同 run-store-smoke/run.sh 同一段理由)。
"$ESBUILD" scripts/archiver-installer-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:electron=./scripts/library-delete-smoke/stubs/electron.ts \
  --alias:@main/claude/RuntimeManager.js=./scripts/archiver-installer-smoke/stubs/runtimeManager.ts \
  --alias:@main/lib/dataRoot.js=./scripts/archiver-installer-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/archiver-installer-smoke/stubs/logger.ts \
  --alias:@main/window.js=./scripts/archiver-installer-smoke/stubs/window.ts \
  --alias:@main/lib/sessionSync.js=./scripts/archiver-installer-smoke/stubs/sessionSync.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

"$ESBUILD" scripts/archiver-installer-smoke/clean.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:electron=./scripts/archiver-installer-smoke/stubs/electron-clean.ts \
  --alias:@main/lib/dataRoot.js=./scripts/archiver-installer-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/archiver-installer-smoke/stubs/logger.ts \
  --alias:@main/window.js=./scripts/archiver-installer-smoke/stubs/window.ts \
  --alias:@main/lib/sessionSync.js=./scripts/archiver-installer-smoke/stubs/sessionSync.ts \
  --outfile="$CLEAN_OUT/clean.mjs" --log-level=error

export MCODE_SMOKE_DATA_ROOT="$DATA"
export MCODE_SMOKE_RUNTIME_ROOT="$RUNTIMES"
node "$OUT/smoke.mjs"

export MCODE_SMOKE_RUNTIME_ROOT="$RUNTIMES_CLEAN"
node "$CLEAN_OUT/clean.mjs"
