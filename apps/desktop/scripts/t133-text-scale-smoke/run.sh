#!/usr/bin/env bash
# 【T133】text-sm → text-body 迁移的零变化与按文件守恒。
#
# 这套不 import 产品代码、不起 Electron —— 它扫源码与 tailwind 配置，
# 断言「每个迁移文件仍有它的 text-body」以及「禁区没被误改」。
#
# 用 esbuild 打一次薄包（main.ts 是 TS），然后 node 跑。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."
source "$HERE/../lib/esbuild-path.sh"
if [[ -z "$ESBUILD" ]]; then echo "Missing existing esbuild; no dependency installation attempted" >&2; exit 1; fi

OUT=$(mktemp -d "${TMPDIR:-/tmp}/mcode-t133-text-scale.XXXXXX")
trap 'rm -rf "$OUT"' EXIT

"$ESBUILD" scripts/t133-text-scale-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
