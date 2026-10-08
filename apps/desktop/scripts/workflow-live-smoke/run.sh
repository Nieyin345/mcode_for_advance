#!/usr/bin/env bash
# workflow-live-smoke — `renderer/lib/workflowLive.ts` 运行现场封顶(MAX_RUNS=24)。
# 见 main.ts 文件头。react 换成一个最小桩(只需 useSyncExternalStore 存在)。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-workflow-live-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$(dirname "$0")/../lib/esbuild-path.sh"
if [[ -z "$ESBUILD" ]]; then echo "esbuild not found in node_modules (no network fallback)" >&2; exit 1; fi

"$ESBUILD" scripts/workflow-live-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:react=./scripts/workflow-live-smoke/react-stub.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
