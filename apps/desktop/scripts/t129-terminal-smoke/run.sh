#!/usr/bin/env bash
# 【T129】底部终端「默认关闭」与 PTY 保活的结构回归。
#
# 这套**不 import 任何主进程代码、不起 Electron** —— 它读渲染端源码，
# 断言「保活所需的结构条件」而不是「PTY 真的活着」（后者需要真 Electron）。
#
# 用 esbuild 打一次薄包（main.ts 是 TS），然后 node 跑。
set -euo pipefail
cd "$(dirname "$0")/../.."
HERE=$(cd "$(dirname "$0")" && pwd)
source "$HERE/../lib/esbuild-path.sh"
if [[ -z "$ESBUILD" ]]; then echo "Missing existing esbuild; no dependency installation attempted" >&2; exit 1; fi

OUT=$(mktemp -d "${TMPDIR:-/tmp}/mcode-t129-terminal.XXXXXX")
trap 'rm -rf "$OUT"' EXIT

"$ESBUILD" scripts/t129-terminal-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
