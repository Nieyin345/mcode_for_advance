#!/usr/bin/env bash
# 【MC-072】code 节点跑完之后的**宿主后处理**(收进库 / 挂回 Markdown)必须受工作流取消管。
# 直接驱动生产的 orchestration/adoptFromCode.ts,用**内存假 host**(不起 Electron、不碰真库)。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."
OUT=$(mktemp -d /tmp/mcode-host-action-cancel.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
source "$HERE/../lib/esbuild-path.sh"
if [[ -z "$ESBUILD" ]]; then echo "Missing existing esbuild" >&2; exit 1; fi
"$ESBUILD" scripts/host-action-cancel-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --external:ssh2 \
  --outfile="$OUT/smoke.mjs" --log-level=error
node "$OUT/smoke.mjs"
