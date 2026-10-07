#!/usr/bin/env bash
# Headless smoke for **一条 IPC 要走全三层** —— 见 main.ts 文件头。
#
# 这一套不装任何东西、不起 Electron:它扫仓库里那几份源码(契约 / preload / 主进程 /
# 手机端),再拿它们互相对账。所以没有桩、没有临时数据根 —— 读不到就应该红(那说明
# 文件挪走了,不是"没得测")。
#
# 它 import `@contracts/ipc`(通道名那一份真相),而契约包**不 import electron**
# (已核:packages/contracts/src 里零个 `from "electron"`),所以 esbuild 不会碰到
# electron,不需要换桩。
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT=$(mktemp -d /tmp/mcode-ipc-wiring-smoke.XXXXXX)
trap 'rm -rf "$OUT"' EXIT

# esbuild rides along as vite's transitive dep (not a direct dependency); fall
# back to npx when absent.
source "$(dirname "$0")/../lib/esbuild-path.sh"

"$ESBUILD" scripts/ipc-wiring-smoke/main.ts \
  --bundle --platform=node --format=esm \
  --tsconfig=tsconfig.json \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
