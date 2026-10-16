#!/usr/bin/env bash
# 会话消息列表**块级改写**的回归网（`renderer/stores/sessionStoreBlocks.ts`）。
#
# 这个文件是从 `sessionStoreHelpers.ts` 拆出来的一整段纯函数 —— 拿 `ChatMessage[]`、
# 改一类块、返回新数组。拆之前它**一套测试都没有**（`grep` 过 `scripts/`：
# `upsertLivePlanBlock` / `appendTurnCardBlock` / `capNodeArchives` /
# `demotePreviousLatestTurnFiles` / `findOpenTurnTrailingAssistant` 五个名字在断言里
# 一次都没出现过）。于是「计划卡会不会重复插」「归档封顶会不会把原数组改掉」
# 这种事只能靠人眼看长对话——而长对话正好是人看不完的那种。
#
# 全部是纯函数、不碰 DOM / store（只 import type + 一个 `translate` 之类的真依赖），
# 所以 esbuild 打包后直接 node 跑，不需要任何 --alias。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-session-blocks-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/session-blocks-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
