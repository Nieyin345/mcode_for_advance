#!/usr/bin/env bash
# 【T142】text-sm → text-body 迁移的守护。
#
# 核心是第 [1] 组：读 tailwind.config.js 的**真身**，断言 body 恰好是
# 14px/20px（= Tailwind text-sm 的默认值）。「这 22 处零视觉变化」全靠这个前提，
# 而它原本没有任何断言守着。
#
# 第 [2] 组扫 .tsx 时会先剥注释 —— cn.ts / sessionStore.ts 的注释里各有一处
# 字面量 text-sm（解释 Tailwind 内置档位），它们不是用法。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."
source "$HERE/../lib/esbuild-path.sh"
if [[ -z "$ESBUILD" ]]; then echo "Missing existing esbuild; no dependency installation attempted" >&2; exit 1; fi

OUT=$(mktemp -d "${TMPDIR:-/tmp}/mcode-t142-tier-migration.XXXXXX")
trap 'rm -rf "$OUT"' EXIT

"$ESBUILD" scripts/t142-font-tier-migration-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
