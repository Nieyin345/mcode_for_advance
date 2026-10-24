#!/usr/bin/env bash
# 【F016】拒绝信息诚实性回归。
#
# ⚠️ **必须在 `apps/desktop` 下调用**（`cd "$(dirname "$0")/../.."` 依赖调用者 cwd）。
# 从仓库根调用会解析成 `apps/desktop/scripts`，`lib/esbuild-path.sh` 找不到 → rc=127，
# 而日志只有一行，看起来像「跑了但没红」。
#
# 本套不碰磁盘、不联网：自己用 `node:zlib` 造 ZIP，直接喂 `readMinimalVsix`。
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."
source "$HERE/../lib/esbuild-path.sh"
if [[ -z "$ESBUILD" ]]; then echo "Missing existing esbuild; no dependency installation attempted" >&2; exit 1; fi

OUT=$(mktemp -d "${TMPDIR:-/tmp}/mcode-f016-reject.XXXXXX")
trap 'rm -rf "$OUT"' EXIT

"$ESBUILD" scripts/vsix-reject-reason-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --alias:@main=./src/main --alias:@contracts=../../packages/contracts/src \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
