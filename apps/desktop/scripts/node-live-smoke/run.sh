#!/usr/bin/env bash
# Headless smoke for **节点跑着的时候卡片上有没有东西在动**
# (`main/orchestration/runner.ts` 的进度上报那一段)。见 main.ts 文件头。
#
# 真的跑一次 `startWorkflowRun`(真库、真会话行、真事件出口),只把**引擎那一侧**
# 换成桩(`stubs/runtimeManager.ts`)—— 真的 RuntimeManager 一 `bindSession` 就会
# 把三个引擎实现和每个的 MCP 工具表全拉起来,无头跑不起来。
#
# ⚠️ 数据根指向 `mktemp -d`(见 stubs/dataRoot.ts 里那句"没设就抛"):这一套会建库、
# 写会话行,指错了就是拿空库盖掉用户的聊天记录。跑完连目录一起删。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-node-live-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-node-live-data.XXXXXX)
trap 'rm -rf "$OUT" "$DATA"' EXIT

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# back to npx when absent.
ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [ -z "$ESBUILD" ]; then ESBUILD="npx esbuild"; fi

# `--banner` 那一行是给 **sql.js** 的:它的 asm 构建里有 `require("node:fs")` /
# `require("node:crypto")`,而定死的 ESM 输出**没有 `require`** —— esbuild 会把它换成
# 一句 `throw new Error('Dynamic require of "node:fs" is not supported')`。给它一个
# 真的 `require`,它就能跑(同 run-store-smoke / session-fork-smoke)。
#
# 那几个 `--alias` 各自挡一条无头跑不了的链:
#   - `dataRoot`   —— 真的那个读 `app.getPath("userData")`(指向真数据根,危险);
#   - `logger`     —— 真的那个往 `userData/logs` 写文件;
#   - `electron`   —— `store/db.ts` 与 `lib/secretStore.ts` 都要它(`app` / `safeStorage`);
#   - `window`     —— 真的那个拿着 BrowserWindow;这一套**要靠它接住**发往渲染端的事件;
#   - `runtimeManager` —— 见文件头;
#   - `providerRegistry` —— 真的那个在模块底部**注册三家引擎实现**,那条链无头起不来。
#     ⚠️ **不能只切 RuntimeManager 这一刀**:`runner.ts` 自己也 import 了注册表(查"这一步
#     指定的引擎装了没有"、拼能力清单),那两句是被测路径的一部分。所以这个桩不是空文件 ——
#     它诚实地报"一个引擎都没装"(见那个桩的注释);
#   - `workflows/seed` —— 真的那个是二十几个 Vite `?raw` 导入(`?raw` 的 `.py`、连后缀
#     都没有的 `LICENSE`),esbuild 不认那些后缀;而 `runner.ts` → `library.ts` →
#     `builtins.ts` 一定会走到它。**这一刀只能切在 seed 上**:切在 `library` 上虽然也能
#     打包,但 `getWorkflow` 就没了 —— 那是被测路径本身(`startWorkflowRun` 第一句就是
#     它),切掉等于把被测的东西换成了桩;
#   - `pluginManager` —— 真的那个读插件目录、spawn git。节点类型清单只要内置那一份。
#
# `main.ts` 里还有两处 `@renderer/*` 的动态 import(渲染端 store),它们属于**同一个
# 包**、且走 `prelude.ts` 铺好的浏览器全局量,所以不需要额外 alias。
#
# 唯一例外是 `monacoSetup`:renderer store 里有一句动态 import 拉它(LSP worker 引导),
# 而那底下是 `.ttf` / `.css` / `?worker` 这些**只有 vite 认得**的东西。本套走不到那条
# 路,所以按 `session-store-smoke` 的做法把它标成 external —— 留在产物里不解析,而不是
# 教 esbuild 认 monaco 那套资源图。
"$ESBUILD" scripts/node-live-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --external:@renderer/lib/monacoSetup.js \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --alias:@main/lib/dataRoot.js=./scripts/node-live-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/node-live-smoke/stubs/logger.ts \
  --alias:electron=./scripts/node-live-smoke/stubs/electron.ts \
  --alias:@main/window.js=./scripts/node-live-smoke/stubs/window.ts \
  --alias:@main/claude/RuntimeManager.js=./scripts/node-live-smoke/stubs/runtimeManager.ts \
  --alias:@main/providers/registry.js=./scripts/node-live-smoke/stubs/providerRegistry.ts \
  --alias:@main/workflows/seed.js=./scripts/node-live-smoke/stubs/workflowsSeed.ts \
  --alias:@main/plugins/pluginManager.js=./scripts/node-live-smoke/stubs/pluginManager.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

MCODE_SMOKE_DATA_ROOT="$DATA" node "$OUT/smoke.mjs"
