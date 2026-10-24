#!/usr/bin/env bash
# 【T132】聊天区不得用硬抄 em 系数代替 --chat-fs-* 变量。
#
# 这套不 import 产品代码、不起 Electron —— 它扫聊天区源码，断言
# 「没有 `text-[0.7857em]` 这类字面量」以及「改成了变量写法」。
#
# 用 esbuild 打一次薄包（main.ts 是 TS），然后 node 跑。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."
source "$HERE/../lib/esbuild-path.sh"
if [[ -z "$ESBUILD" ]]; then echo "Missing existing esbuild; no dependency installation attempted" >&2; exit 1; fi

OUT=$(mktemp -d "${TMPDIR:-/tmp}/mcode-t132-chat-em.XXXXXX")
trap 'rm -rf "$OUT"' EXIT

"$ESBUILD" scripts/t132-chat-em-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
