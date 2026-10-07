#!/usr/bin/env bash
# Headless smoke for **`CollectionRepo.move`** —— 「把分类挪到别的父下面」。
#
# 真的建一个 sqlite 库、真的建集合、真的挪。数据根换成临时目录
# (见 stubs/dataRoot.ts 里那句"没设就抛":指错地方等于拿空库盖掉用户的资料库)。
#
# ## 为什么这套走**真的那条 IPC**
#
# 挪一条分类这件事,判据**整个住在 `CollectionRepo.move` 的函数体里**(判环、判重名、
# 重排同级 sort_order),而它从前门进来是 `library:moveCollection` 那条 handler。
# 只 import `repositories.ts` 直接调 `CollectionRepo.move`,验的就是"我调的这个函数
# 现在返回什么";有人把 handler 里那个方法名换掉、或者 schema 把 `parentId` 吃了,
# 这套照样全绿 —— 那正是 CLAUDE.md 里那句「套件跑绿但**根本没覆盖到**被改的文件」。
# 所以按 `library-trash-smoke` 的办法搭:`ipcMain` 的记名替身 + 按 channel 取回注册
# 进去的真函数,然后调那个 user action 本身。
#
# ## ⚠️ 别名一长串是走真 handler 的代价
#
# `@main/ipc/library.js` 的 import 图里有 `import { shell } from "electron"`,还经
# seed 拖到二十几个 Vite `?raw` 的 `.py`。不换桩的话 esbuild 直接以
# `No loader is configured for ".py" files` 挂掉(报的是 seed 里那几行,看着和被测
# 代码无关)。下面这一组与 `library-delete-smoke` / `library-trash-smoke` 摆同一套。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-move-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-move-data.XXXXXX)
# 给 bundle 一个 node_modules 视野:`library/pdfText.ts` 顶层有一句
# `require.resolve("pdfjs-dist/package.json")`,运行期从 bundle 自己位置解析。
ln -s "$PWD/node_modules" "$OUT/node_modules"
trap 'rm -rf "$OUT" "$DATA"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

# `--banner` 那一行是给 sql.js 的(理由同 run-store-smoke/run.sh):它的 asm 构建里有
# `require("node:fs")`,而定死的 ESM 输出没有 `require`。
"$ESBUILD" scripts/library-move-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --external:pdfjs-dist \
  --alias:electron=./scripts/library-delete-smoke/stubs/electron.ts \
  --alias:@main/lib/dataRoot.js=./scripts/run-store-smoke/stubs/dataRoot.ts \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --alias:@main/window.js=./scripts/library-delete-smoke/stubs/window.ts \
  --alias:@main/claude/RuntimeManager.js=./scripts/library-delete-smoke/stubs/runtimeManager.ts \
  --alias:@main/browser/BrowserManager.js=./scripts/library-delete-smoke/stubs/browserManager.ts \
  --alias:@main/workflows/seed.js=./scripts/library-delete-smoke/stubs/workflowsSeed.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

export MCODE_SMOKE_DATA_ROOT="$DATA"

node "$OUT/smoke.mjs"
