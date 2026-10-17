#!/usr/bin/env bash
# preset-scripts-sync —— 把 `resources/presets/workflows.json` 里两段 Python 正文
# 从 `src/main/workflows/assets.ts` 重新生成（MC-008 的系统性修法：预设不手维护正文）。
#
#   --check  只核对，漂移就非零退出（CI / 冒烟用）
#   --write  把权威正文写回预设文件
#
# 打包后再跑：`assets.ts` 是纯字面量，打包结果就是真值（同 mineru-py-smoke 的理由）。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-preset-scripts-sync.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/preset-scripts-sync/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/sync.mjs" --log-level=error

# 工作目录 = apps/desktop，`presetFile()` 按它拼 `resources/presets/workflows.json`。
node "$OUT/sync.mjs" "$@"
