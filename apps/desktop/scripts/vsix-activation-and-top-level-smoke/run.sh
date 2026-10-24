#!/usr/bin/env bash
# 【F014】顶层字段分类 + activationEvents 对齐真实运行时。
#
# 这套**不碰网络**；唯一读磁盘的地方是 [7]，读本机已安装的 rainbow-csv 的 package.json
# （没装就跳过那一组，不影响其余部分）。
set -euo pipefail
cd "$(dirname "$0")/../.."
source "$(dirname "$0")/../lib/esbuild-path.sh"
if [[ -z "$ESBUILD" ]]; then echo "Missing existing esbuild; no dependency installation attempted" >&2; exit 1; fi

OUT=$(mktemp -d "${TMPDIR:-/tmp}/mcode-f014-vsix.XXXXXX")
trap 'rm -rf "$OUT"' EXIT

"$ESBUILD" scripts/vsix-activation-and-top-level-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --alias:@main=./src/main --alias:@contracts=../../packages/contracts/src \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
