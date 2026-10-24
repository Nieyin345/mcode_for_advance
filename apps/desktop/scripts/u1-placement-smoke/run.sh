#!/usr/bin/env bash
# W28 —— U1 宿主窗口位置判据（纯函数，无头）。断言对象是真身：
# `electron-u1/driver/runner.ts` 导出的 `chooseHostWindowPlacement`。
#
# 不起 Electron、不碰数据根、不写磁盘：`runner.ts` 顶层无副作用，所有 electron
# 用法都在函数体内。`electron` 换成一个**全部显式抛错**的空壳 —— 如果哪天
# runner.ts 的顶层开始碰 electron，这套会当场炸，而不是安静地绿。
#
# 用法（在 apps/desktop 下）：bash scripts/u1-placement-smoke/run.sh
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."

OUT=$(mktemp -d "${TMPDIR:-/tmp}/mcode-u1-placement.XXXXXX")
trap 'rm -rf "$OUT"' EXIT
source "$HERE/../lib/esbuild-path.sh"

# `runner.ts` 里有几处**函数体内**的 `await import("@main/store/db.js")` 等
# （真 Electron 旅程才走得到）。esbuild 会把动态 import 也静态打进 bundle，
# 于是整套主进程图被拖进来 —— 本套只需要纯算术那一小块，把 `@main/*` 标成
# external：它们留在 `import("@main/…")` 原样，永远不被执行。
"$ESBUILD" scripts/u1-placement-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:electron=./scripts/u1-placement-smoke/stubs/electron.ts \
  --external:@main/* \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
