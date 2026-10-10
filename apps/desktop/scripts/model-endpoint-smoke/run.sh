#!/usr/bin/env bash
# `lib/modelEndpoint.ts`(向网关端点发一次轻请求)的回归网。
# 纯件只 import node:http/node:url,不碰 electron,故无需换桩。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-model-endpoint.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/model-endpoint-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
