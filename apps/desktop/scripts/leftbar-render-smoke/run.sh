#!/usr/bin/env bash
# 左栏会话树的渲染网 —— `LeftBar` / `LeftBarParts` 的 9 个子单元真 SSR 一遍。
#
# 为什么需要它:`smokes-for.sh src/renderer/components/layout/LeftBar.tsx` 报「没有套件覆盖」,
# 而 `LeftBarParts.tsx` 是 1164 行拆出来的活代码。typecheck 能抓「名字不存在」,抓不到
# 「搬错的函数体渲染期才炸」。这里把每个子单元 `renderToString`,断言真渲染 + 输出预期文本。
set -euo pipefail
cd "$(dirname "$0")/../.."          # → apps/desktop

OUT=$(mktemp -d /tmp/mcode-leftbar-render-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

# LeftBar 那一族的 import 链会拖进 monaco(worker 说明符 esbuild 解不了)与 brand-logo.png。
# monaco 用桩替掉、图片按 dataurl 内联即可 —— 都只影响打包,不影响被测的渲染逻辑。
"$ESBUILD" scripts/leftbar-render-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --jsx=automatic \
  --tsconfig=tsconfig.json \
  --loader:.png=dataurl \
  --alias:@renderer/lib/monacoSetup.js=./scripts/leftbar-render-smoke/monacoStub.ts \
  --external:monaco-editor \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
