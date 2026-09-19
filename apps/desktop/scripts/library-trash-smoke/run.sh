#!/usr/bin/env bash
# Headless smoke for `main/library/trash.ts`(孤儿条目去哪儿)。
#
# 真的建一个 sqlite 库、真的建集合、真的删 —— 脚下那个数据根换成临时目录
# (见 stubs/dataRoot.ts 里那句"没设就抛":指错地方等于拿空库盖掉用户的资料库)。
#
# ## ⚠️ 别名一长串是 §4 改走**真 handler** 之后才需要的（2026-09-20）
#
# 原来只要 dataRoot / logger 两个桩:那时 §4 是复述,main.ts 只 import `trash.ts` 和
# repos,全是纯数据库、不碰 electron。
#
# 改走真的那条 IPC 之后,main.ts 要 import `@main/ipc/library.js` —— 那一个的 import
# 图里**自己**就有 `import { shell } from "electron"`,还经 seed 拖到二十几个 Vite
# `?raw` 的 `.py`。不换桩的话 esbuild 直接以
# `No loader is configured for ".py" files` 挂掉(报的是 seed 里那几行,看着和被测
# 代码无关)。所以下面这一组跟 `library-delete-smoke` 摆同一套,逐条理由见那支。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-trash-smoke.XXXXXX)
DATA=$(mktemp -d /tmp/mcode-trash-data.XXXXXX)
# 给 bundle 一个 node_modules 视野:`library/pdfText.ts` 顶层有一句
# `require.resolve("pdfjs-dist/package.json")`,运行期从 bundle 自己位置解析。
ln -s "$PWD/node_modules" "$OUT/node_modules"
trap 'rm -rf "$OUT" "$DATA"' EXIT

ESBUILD=$(find ../../node_modules/.pnpm -path "*esbuild/bin/esbuild" -type f 2>/dev/null | sort -V | tail -1)
if [[ -z "$ESBUILD" ]]; then ESBUILD="npx esbuild"; fi

# `--banner` 那一行是给 sql.js 的(理由同 run-store-smoke/run.sh):它的 asm 构建里有
# `require("node:fs")`,而定死的 ESM 输出没有 `require`。
"$ESBUILD" scripts/library-trash-smoke/main.ts \
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
