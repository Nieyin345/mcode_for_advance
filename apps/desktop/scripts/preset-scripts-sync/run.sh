#!/usr/bin/env bash
# preset-scripts-sync —— 把 `resources/presets/workflows.json` 里两段 Python 正文
# 从 `src/main/workflows/assets.ts` 重新生成（MC-008 的系统性修法：预设不手维护正文）。
#
#   --check  只核对，漂移就非零退出（CI / 冒烟用）
#   --write  把权威正文写回预设文件
#
# 打包后再跑：`assets.ts` 是纯字面量，打包结果就是真值（同 mineru-py-smoke 的理由）。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."

OUT=$(mktemp -d /tmp/mcode-preset-scripts-sync.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

source "$HERE/../lib/esbuild-path.sh"

"$ESBUILD" scripts/preset-scripts-sync/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/sync.mjs" --log-level=error

# 工作目录 = apps/desktop，`presetFile()` 按它拼 `resources/presets/workflows.json`。
#
# ⚠️ **不传参数时默认 `--check`**。`run-smokes.mjs` 调套件时不带参数，
# 而本脚本没有「两者都不做」的模式 —— 空参数会让 main.ts 打印用法后退出（rc=2），
# 全量跑法里看起来像「套件挂了」。核对是安全的那一档：只读、不改任何文件。
if [ "$#" -eq 0 ]; then
  set -- --check
fi
node "$OUT/sync.mjs" "$@"
