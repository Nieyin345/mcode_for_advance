#!/usr/bin/env bash
# 【T140】cn() 必须保住 CDS 七档字号。
#
# 这套**直接 import 产品代码**（`src/renderer/lib/cn.ts`），断言真实输出 ——
# 不是源码文本。T121/T133 那种 `src.includes("text-caption")` 在运行时一直是
# 绿的假象，因为 twMerge 把档位当颜色丢掉了。
#
# 用 esbuild 打一次薄包（main.ts 是 TS），然后 node 跑。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."
source "$HERE/../lib/esbuild-path.sh"
if [[ -z "$ESBUILD" ]]; then echo "Missing existing esbuild; no dependency installation attempted" >&2; exit 1; fi

OUT=$(mktemp -d "${TMPDIR:-/tmp}/mcode-t140-cn-tier.XXXXXX")
trap 'rm -rf "$OUT"' EXIT

"$ESBUILD" scripts/t140-cn-tier-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
