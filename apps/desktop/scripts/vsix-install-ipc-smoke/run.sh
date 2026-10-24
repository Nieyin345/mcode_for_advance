#!/usr/bin/env bash
# 【F006】从 .vsix 安装 —— IPC 三层齐全性 + 复用性 + 诚实性回归。
#
# 这套**不起 Electron、不 import 主进程实现**（除了 contracts 的 schema）。
# 它验的是四件事：
#   1. 三层齐全：contracts schema → rpcMap → handler → preload 白名单，缺一层调用端就看不到
#   2. handler 复用 `VscodeL1Bridge.install`，不是自己抄了一份读 VSIX 的逻辑
#   3. `deny` 在**读文件之前**就中止（磁盘零写入）
#   4. UI 在用户选文件**之前**就说明了 24 KiB 限制
set -euo pipefail
cd "$(dirname "$0")/../.."
source "$(dirname "$0")/../lib/esbuild-path.sh"
if [[ -z "$ESBUILD" ]]; then echo "Missing existing esbuild; no dependency installation attempted" >&2; exit 1; fi

OUT=$(mktemp -d "${TMPDIR:-/tmp}/mcode-vsix-ipc.XXXXXX")
trap 'rm -rf "$OUT"' EXIT

"$ESBUILD" scripts/vsix-install-ipc-smoke/main.ts \
  --bundle --platform=node --format=esm --tsconfig=tsconfig.json \
  --alias:@contracts=../../packages/contracts/src \
  --banner:js="import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" \
  --outfile="$OUT/smoke.mjs" --log-level=error

node "$OUT/smoke.mjs"
