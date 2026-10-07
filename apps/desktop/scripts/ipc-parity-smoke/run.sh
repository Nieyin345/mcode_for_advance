#!/usr/bin/env bash
# `ipc/index.ts` 那座总注册表的回归网 —— 见 main.ts 文件头讲的为什么是这么写的。
#
# ⚠️ **这套不碰数据库、不写磁盘**,所以这里**没有** `MCODE_SMOKE_DATA_ROOT`。
#    它读的是三个源文件 + 一张编译进来的常量表(same 契约,主进程和 preload 都
#    import 它)。读不到文件会立刻抛,不会是"静默全绿"。
#
# 也**不需要** `--alias` 换桩:整条 import 图只有 `@contracts/ipc`,够不到
# electron / sql.js 那一片。哪天真够到了,再按 `library-trash-smoke/run.sh`
# 那一串补上。
set -euo pipefail
cd "$(dirname "$0")/../.."          # → apps/desktop

OUT=$(mktemp -d /tmp/mcode-ipc-parity.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

# `--banner` 那一行留着:今天这条 import 图够不到 sql.js,但 `IPC` 表所在的
# `@contracts/ipc` 是个 barrel,加一条 import 就可能把 sql.js 的 asm 构建拉进来
# (它里面有 `require("node:fs")`),而定死的 ESM 输出没有 `require`。垫着不亏。
"$ESBUILD" scripts/ipc-parity-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
