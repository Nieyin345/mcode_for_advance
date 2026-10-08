#!/usr/bin/env bash
# Headless smoke for **页内注入脚本的槽位填充** —— 见 main.ts 文件头。
#
# 被测文件 `main/browser/snapshotScript.ts` **零 import、纯字符串常量**,所以本套
# 不需要任何桩、不碰数据根、不起 Electron、不连网 —— 只把那个模块单独打进来跑。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-browser-script-injection.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/browser-script-injection-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
