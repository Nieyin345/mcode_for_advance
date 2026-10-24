#!/usr/bin/env bash
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE/../.."          # → apps/desktop

# 这套测纯策略模块 + 读 provider 源码断言接线，第 9/10 节还用 fakeIpc 真驱动
# `ipc/engineTools.ts` 的两个 handler（走**默认策略路径**）。不建库、不起 Electron。
#
# ⚠️ **用户根（HOME / USERPROFILE）必须换成临时目录**：默认路径拼在 `homedir()` 下，
# 第 9 节会真的读写它。指错地方 = 拿用户真 `~/.mcode/engine-tools.json` 当测试场地
# （main.ts 开头校验没指到就拒绝运行）。Windows 上 `os.homedir()` 读 USERPROFILE，
# 其余平台读 HOME —— 两个都指过去（照 `pi-models-store-smoke` 的先例）。
OUT=$(mktemp -d /tmp/mcode-engine-tools.XXXXXX)
HOME_DIR=$(mktemp -d /tmp/mcode-engine-tools-home.XXXXXX)
trap 'rm -rf "$OUT" "$HOME_DIR"' EXIT
source "$HERE/../lib/esbuild-path.sh"

"$ESBUILD" scripts/engine-tools-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --alias:@main/lib/logger.js=./scripts/run-store-smoke/stubs/logger.ts \
  --outfile="$OUT/smoke.mjs" --log-level=error

if command -v cygpath >/dev/null 2>&1; then HOME_NATIVE=$(cygpath -w "$HOME_DIR"); else HOME_NATIVE="$HOME_DIR"; fi
export HOME="$HOME_NATIVE" USERPROFILE="$HOME_NATIVE" MCODE_SMOKE_HOME="$HOME_NATIVE"

node "$OUT/smoke.mjs"
