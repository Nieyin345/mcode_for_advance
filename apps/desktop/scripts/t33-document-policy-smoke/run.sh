#!/usr/bin/env bash
# 【T33】`document.*` 的审批档位。
#
# 这套只 import 纯逻辑模块（`appControl/policy.ts`），不碰 electron / 磁盘 / 数据库 ——
# 所以没有 dataRoot 桩，也没有 mktemp 数据根。`policy.ts` 自身是纯查表函数。
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE/../.."

OUT=$(mktemp -d /tmp/mcode-t33-policy.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$HERE/../lib/esbuild-path.sh"

"$ESBUILD" scripts/t33-document-policy-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
